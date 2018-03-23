#!/usr/bin/env node

const lockfile = require('../lib/lockfile-pid');

lockfile.lock("/tmp/lockfile-pid_test", {wait: 4000, stale: 1000000}).then(run).catch((err) => {
    console.log("Couldn't lock", err);
    process.exit(1);
});
function run(unlock)
{
    var count = 10;
    setInterval(() => {
        console.log(count--);
        if(!count) {
            lockfile.unlock("/tmp/lockfile-pid_test");
        } else if (count == -3) {
            process.exit();
        }
    }, 1000);
}

