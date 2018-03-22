#!/usr/bin/env node

const lockfile_pid = require('../lib/lockfile_pid');

lockfile_pid.lock("/tmp/lockfile_pid_test", {wait: 10000, stale: 1000000}).then(run).catch((err) => {
    console.log("Couldn't lock", err);
    process.exit(1);
});
function run(unlock)
{
    var count = 10;
    setInterval(() => {
        console.log(count--);
        if(!count) {
            lockfile_pid.unlock("/tmp/lockfile_pid_test");
        } else if (count == -3) {
            process.exit();
        }
    }, 1000);
}

