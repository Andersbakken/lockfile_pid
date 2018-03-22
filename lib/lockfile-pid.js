const find_process = require('find-process');
const fs = require('fs-ext');

function resolvePath(path)
{
    if (/\/$/.exec(path)) {
        path = path.substr(0, path.length - 1);
    }
    const lockPath = path + '.lock';
    let realPath;
    let dirStat, fileStat;
    try {
        realPath = fs.realpathSync(lockPath);
        dirStat = fs.statSync(realPath);
        fileStat = fs.statSync(lockPath + '/data');
    } catch (err) {
        if (!err || (err.code != 'ENOENT' && err.code != 'ENOTDIR')) {
            return undefined;
        }
    }

    let mtime;
    if (dirStat && !dirStat.isDirectory()) {
        try {
            fs.unlinkSync(realPath);
        } catch (err) {
            if (!err || err.code != 'ENOENT') {
                return undefined;
            }
        }
        return resolvePath(path);
    }
    return {
        dir: realPath || lockPath,
        file: (realPath || lockPath) + "/data",
        mtime: fileStat ? fileStat.mtimeMs : undefined
    };
}

var cleanups = [];

function lock(lockPath, opts)
{
    return new Promise(function(resolve, reject) {
        var wait = opts ? opts.wait : undefined;
        var stale = opts ? opts.stale : undefined;
        var goId;
        function go()
        {
            if (goId) {
                clearTimeout(goId);
                goId = undefined;
            }
            let lockFile = resolvePath(lockPath);
            function createLockFile(failOnEEXIST)
            {
                find_process('pid', process.pid).
                    then((data) => {
                        try {
                            fs.mkdirSync(lockFile.dir);
                        } catch (err) {
                            if (!err || err.code != 'EEXIST' || failOnEEXIST) {
                                reject(err);
                            } else {
                                next();
                            }
                            return;
                        }
                        try {
                            fs.writeFileSync(lockFile.file, process.pid + "\n" + data[0].cmd + "\n");
                        } catch (err) {
                            reject("Failed to write lockfile " + err.toString());
                            return;
                        }
                        cleanups[lockFile.dir] = true;
                        resolve(function() { unlock(lockFile.dir); });
                    }).catch((err) => {
                        reject(err);
                    });
            }

            function next()
            {
                if (lockFile.mtime && stale && Date.now - lockFile.age >= stale) {
                    createLockFile(true);
                    return;
                }
                if (wait !== undefined) {
                    if (wait <= 0) {
                        reject("Timed out waiting for lock");
                        return;
                    }
                    wait -= 1000;
                }
                goId = setTimeout(go, 1000);
            }

            // console.log("got file", lockFile);
            if (!lockFile) {
                reject("Failed to resolve lock file path");
                return;
            }
            let contents;
            try {
                contents = fs.readFileSync(lockFile.file, 'utf8').split('\n');
            } catch (err) {
                if (!err || err.code != 'ENOENT') {
                    next();
                    return;
                }
            }
            if (contents && contents.length >= 2) {
                let pid = parseInt(contents[0]);
                if (pid) {
                    // console.log("Got a pid here", pid);
                    find_process('pid', pid).
                        then((data) => {
                            // console.log("got data", JSON.stringify(data, null, 4));
                            if (!data.length || data[0].cmd != contents[1]) {
                                createLockFile();
                            } else {
                                next();
                            }
                        }).catch((err) => {
                            // console.log("got err", err);
                            next();
                        });
                }
                return;
            }
            createLockFile();
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
        let pid;
        try {
            pid = fs.readFileSync(lockFile.file, 'utf8').split('\n')[0];
        } catch (err) {
        }

        if (pid && pid != process.pid) {
            reject("This is not my lock file " + pid + " vs " + process.pid);
            return;
        }

        try {
            rmdir(lockFile.dir);
            delete cleanups[lockFile.dir];
        } catch (err) {
            if (!err || err.code != 'ENOENT') {
                reject(err);
                return;
            }
        }
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
