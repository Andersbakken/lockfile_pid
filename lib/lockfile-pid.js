'use strict';
const find_process = require('find-process');
const fs = require('fs');
const constants = require('constants');
const verbose = false;
const child_process = require('child_process');

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

if (!$file) {
   die("usage: $0 <file>]\n");
}

print STDERR "TRYING\n";
open(FH, ">>", $file) || die($!);
{
    my $errors = 0;
    open local(*STDERR), '>', \$errors;
    if (!flock(FH, LOCK_EX|LOCK_NB)) {
        if (!$errors) {
            exit(101);
        } else {
            exit(102);
        }
    }
}
eval {
    print STDOUT "LOCKED\n";
    local $SIG{ALRM} = sub { print STDERR "GOT ALARM!\n" };
    sleep;
};
print STDERR "UNLOCKING\n";
flock(FH, LOCK_UN);
print STDERR "UNLOCKED\n";
`;


function fileLock(path, lock)
{
    return new Promise((resolve, reject) => {
        let fd;
        try {
            fd = fs.openSync(path, "a+");
        } catch (err) {
            reject(err);
            return;
        }
        // console.log(perlScript);
        var flock = child_process.spawn("perl", [ "-e", perlScript, path ], [ null, "pipe", null ]);

        flock.once("close", (event) => {
            if (!event)
                event = { signal: 102 }; // no idea what went wrong
            switch (event.signal) {
            case 101: // failed to lock
                try {
                    fs.closeSync(fd);
                } catch (err) {
                }
                resolve();
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
    });
}

function readLockFile(fd)
{
    let contents;
    try {
        let buffer = new Buffer(1024);
        let read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        contents = buffer.slice(0, read).toString('utf8').split('\n');
    } catch (err) {
        if (!err || err.code != 'ENOENT') {
            return undefined;
        }
    }
    return contents || [];
}

var cleanups = {};

function lock(lockPath, opts)
{
    if (verbose)
        console.log(`Called lock ${lockPath}`);
    return new Promise(function(resolve, reject) {
        var wait = opts ? opts.wait : undefined;
        var stale = opts ? opts.stale : undefined;

        function go()
        {
            let lockFile = resolvePath(lockPath);

            function next()
            {
                if (wait !== undefined) {
                    if (wait <= 0) {
                        reject("Timed out waiting for lock");
                        return;
                    }
                    wait -= 1000;
                }
                setTimeout(go, 1000);
            }

            if (!lockFile) {
                reject("Failed to resolve lock file path");
                return;
            }
            fileLock(lockFile.path).then((result) => {
                if (!result) {
                    if (verbose)
                        console.log("Couldn't flock", lockFile.path);
                    next();
                    return;
                }
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
                                reject("Failed to write lockfile " + err.toString());
                                return;
                            }
                            fileUnlock();
                            if (verbose)
                                console.log("Wrote lockFile", lockFile.path);
                            cleanups[lockFile.path] = true;
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
        if (!lockFile) {
            reject("Failed to resolve lock file path");
            return;
        }
        fileLock(lockFile.path).then((result) => {
            if (!result) {
                reject("Couldn't get file lock");
                return;
            }
            const fd = result.fd;
            const fileUnlock = result.fileUnlock;
            let pid = parseInt(readLockFile(fd)[0]);
            if (pid && pid != process.pid) {
                reject("This is not my lock file " + pid + " vs " + process.pid);
                return;
            }

            try {
                fs.unlinkSync(path);
            } catch (err) {
                if (!err || err.code != 'ENOENT') {
                    fileUnlock();
                    reject(err);
                    return;
                }
            }
            fileUnlock();
            delete cleanups[path];
            resolve();
        }, (err) => {
            reject(err);
        });
    });
}

function onExit()
{
    // console.log("Got here", cleanups);
    for (var file in cleanups) {
        try {
            fs.unlinkSync(file);
        } catch (err) {
        }
        delete cleanups[file];
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
