const find_process = require('find-process');
const fs = require('fs-ext');
const constants = require('constants');

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

function fileLock(path, lock)
{
    let fd;
    try {
        fd = fs.openSync(path, "a+");
    } catch (err) {
        return undefined;
    }
    let ret;
    try {
        // ret = fs.fcntlSync(fd, 'setlkw', constants.F_WRLCK);
        fs.flockSync(fd, 'ex');
        fs.seekSync(fd, 0, 0);
    } catch (err) {
        try {
            fs.closeSync(fd);
        } catch (err) {
        }
        return undefined;
    };
    return fd;
}

function fileUnlock(fd)
{
    try {
        fs.flockSync(fd, 'un');
    } catch (err) { };
    try {
        fs.closeSync(fd);
    } catch (err) {
    }
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

var cleanups = [];

function lock(lockPath, opts)
{
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
            var fd = fileLock(lockFile.path);
            if (fd == undefined) {
                next();
                return;
            }

            function writeLockFile()
            {
                find_process('pid', process.pid).
                    then((data) => {
                        try {
                            fs.truncateSync(fd, 0);
                            fs.writeSync(fd, Buffer.from(process.pid + "\n" + data[0].cmd + "\n"));
                        } catch (err) {
                            reject("Failed to write lockfile " + err.toString());
                            return;
                        }
                        fileUnlock(fd);
                        cleanups[lockFile.path] = true;
                        resolve(function() { unlock(lockFile.path); });
                    }).catch((err) => {
                        fileUnlock(fd);
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
                                fileUnlock(fd);
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

        }
        go();
    });
}

function unlock(path)
{
    return new Promise(function(resolve, reject) {
        var lockFile = resolvePath(path);
        if (!lockFile) {
            reject("Failed to resolve lock file path");
            return;
        }
        var fd = fileLock(lockFile.path);
        if (fd === undefined) {
            reject("Couldn't get file lock");
            return;
        }
        let pid = parseInt(readLockFile(fd)[0]);
        if (pid && pid != process.pid) {
            reject("This is not my lock file " + pid + " vs " + process.pid);
            return;
        }

        try {
            fs.unlinkSync(path);
        } catch (err) {
            if (!err || err.code != 'ENOENT') {
                fileUnlock(fd);
                reject(err);
                return;
            }
        }
        fileUnlock(fd);
        delete cleanups[path];
        resolve();
    });
}

function onExit()
{
    // console.log("Got here", cleanups);
    for (var dir in cleanups) {
        try {
            rmdir(dir);
        } catch (err) {
        }
        delete cleanups[dir];
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
