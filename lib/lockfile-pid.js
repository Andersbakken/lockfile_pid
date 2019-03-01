'use strict';
const find_process = require('find-process');
const fs = require('fs');
const constants = require('constants');
const verbose = false;
const child_process = require('child_process');
const path = require('path');

function resolvePath(lockPath)
{
    let realPath;
    let stat;
    try {
        realPath = fs.realpathSync(lockPath);
        stat = fs.statSync(lockPath);
    } catch (err) {
        if (!err || (err.code != 'ENOENT')) {
            return undefined;
        }

        // file doesn't exist but perl will create it, try to see if parent dir exists
        try {
            realPath = fs.realpathSync(path.dirname(lockPath));
        } catch (err) {
            if (!err || (err.code != 'ENOENT')) {
                return undefined;
            }
        }
        realPath = path.join(realPath, path.basename(lockPath));
    }

    if (stat && stat.isDirectory())
        return resolvePath(lockPath + "/lock");
    return {
        path: realPath || lockPath,
        mtime: stat ? stat.mtimeMs : undefined
    };
}

const perlScript = `
use warnings;
use strict;
use Fcntl qw(:flock);
# line buffer
$|=1;

my $file = $ARGV[0];
my $ppid = $ARGV[1];

if (!$file) {
   die("usage: $0 <file>]\\n");
}

print STDERR "TRYING\\n";
open(FH, ">>", $file) || die($!);
{
    my $errors = 0;
    open local(*STDERR), '>', \\$errors;
    if (!flock(FH, LOCK_EX|LOCK_NB)) {
        if (!$errors) {
            exit(101);
        } else {
            exit(102);
        }
    }
}
eval {
    print STDOUT "LOCKED\\n";
    my $done = 0;
    local $SIG{ALRM} = sub { print STDERR "GOT ALARM!\\n"; $done = 1; };
    while (!$done) {
        sleep 1;
        if (!kill(0, $ppid)) {
            $done = 1;
        }
    }
};
print STDERR "UNLOCKING\\n";
flock(FH, LOCK_UN);
print STDERR "UNLOCKED\\n";
`;


function fileLock(path, timeout)
{
    return new Promise((resolve, reject) => {
        let fd;
        try {
            fd = fs.openSync(path, "a+");
        } catch (err) {
            reject(err);
            return;
        }
        function go()
        {
            if (timeout && Date.now() >= timeout) {
                reject(new Error("Timed out waiting for lock"));
                return;
            }

            // console.log(perlScript);
            var flock = child_process.spawn("perl", [ "-e", perlScript, path, process.pid ], [ null, "pipe", null ]);

            flock.once("close", (event) => {
                if (!event) {
                    event = { signal: 102 }; // no idea what went wrong
                } else if (typeof event === 'number') {
                    event = { signal: event };
                }
                switch (event.signal) {
                case 101: // failed to lock
                    setTimeout(go, 250);
                    break;
                case 102: // something went wrong , treat it as a successful lock
                    resolve({ fd: fd, fileUnlock: () => {
                        try {
                            fs.closeSync(fd);
                        } catch (err) {
                        }
                    }});
                    break;
                }
            });

            flock.stdout.on("data", () => {
                resolve({ fd: fd, fileUnlock: () => {
                    try {
                        fs.flockSync(fd, 'un');
                    } catch (err) { };
                    flock.kill("SIGALRM");
                }});
            });
        }
        go();
    });
}

function readLockFile(fd)
{
    let contents;
    try {
        let buffer = Buffer.alloc instanceof Function ? Buffer.alloc(1024) : new Buffer(1024);
        let read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        contents = buffer.slice(0, read).toString('utf8').split('\n');
    } catch (err) {
        if (!err || err.code != 'ENOENT') {
            return undefined;
        }
    }
    return contents || [];
}

var locks = {};

function lock(lockPath, opts)
{
    if (verbose)
        console.log(`Called lock ${lockPath}`);
    return new Promise(function(resolve, reject) {
        var timeout = opts.wait ? Date.now() + opts.wait : undefined;;
        var stale = opts ? opts.stale : undefined;

        function go()
        {
            let lockFile = resolvePath(lockPath);

            function next()
            {
                if (timeout && Date.now() >= timeout) {
                    reject(new Error("Timed out waiting for lock"));
                    return;
                }
                setTimeout(go, 1000);
            }

            if (!lockFile) {
                reject(new Error("Failed to resolve lock file path " + lockPath));
                return;
            }
            if (locks[lockFile.path]) {
                ++locks[lockFile.path];
                if (verbose)
                    console.log("Recursive lock succeeded", lockFile.path);
                resolve(function() { return unlock(lockFile.path); });
                return;
            }
            fileLock(lockFile.path, timeout).then((result) => {
                const fd = result.fd;
                const fileUnlock = result.fileUnlock;

                function writeLockFile()
                {
                    find_process('pid', process.pid).
                        then((data) => {
                            try {
                                fs.ftruncateSync(fd, 0);
                                fs.writeSync(fd, Buffer.from(process.pid + "\n" + data[0].cmd + "\n"));
                            } catch (err) {
                                reject(new Error("Failed to write lockfile " + err.toString()));
                                return;
                            }
                            fileUnlock();
                            if (verbose)
                                console.log("Wrote lockFile", lockFile.path);
                            locks[lockFile.path] = 1;
                            resolve(function() { return unlock(lockFile.path); });
                        }).catch((err) => {
                            fileUnlock();
                            reject(err);
                        });
                }

                let contents = readLockFile(fd);
                if (contents && contents.length >= 2) {
                    let pid = parseInt(contents[0]);
                    if (pid) {
                        find_process('pid', pid).
                            then((data) => {
                                if (data.length && data[0].cmd == contents[1]) {
                                    if (verbose)
                                        console.log("Someone else has the lock", lockFile.path, contents);
                                    fileUnlock();
                                    next();
                                    return;
                                }
                                writeLockFile();
                            }).catch((err) => {
                                writeLockFile();
                            });
                    }
                    return;
                }
                writeLockFile();
            }, (err) => {
                reject(err);
            });
        }
        go();
    });
}

function unlock(path)
{
    if (verbose)
        console.log("Called unlock", path);
    return new Promise(function(resolve, reject) {
        var lockFile = resolvePath(path);
        if (!lockFile || !locks[lockFile.path]) {
            reject(new Error("Failed to resolve lock file path " + JSON.stringify(lockFile)));
            return;
        }
        if (--locks[lockFile.path]) {
            if (verbose)
                console.log("Recursive unlock succeeded", path);
            resolve();
            return;
        }
        fileLock(lockFile.path).then((result) => {
            if (!result) {
                reject(new Error("Couldn't get file lock"));
                return;
            }
            const fd = result.fd;
            const fileUnlock = result.fileUnlock;
            let pid = parseInt(readLockFile(fd)[0]);
            if (pid && pid != process.pid) {
                reject(new Error("This is not my lock file " + pid + " vs " + process.pid));
                fileUnlock();
                return;
            }

            if (!locks[lockFile.path]) {
                try {
                    fs.unlinkSync(path);
                } catch (err) {
                    if (!err || err.code != 'ENOENT') {
                        fileUnlock();
                        reject(err);
                        return;
                    }
                }
                delete locks[path];
            }
            fileUnlock();
            resolve();
        }, (err) => {
            reject(err);
        });
    });
}

function onExit()
{
    // console.log("Got here", locks);
    for (var file in locks) {
        try {
            fs.unlinkSync(file);
        } catch (err) {
        }
        delete locks[file];
    }
}


process.on('exit', onExit);
process.on('SIGINT', () => {
    onExit();
    process.exit();
});


module.exports = {
    lock: lock,
    unlock: unlock
};
