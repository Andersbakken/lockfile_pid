#!/usr/bin/env node

const lockfile = require('../lib/lockfile-pid');
const fs = require('fs');

// var count = 100;
// function go() {
//     lockfile.lock("/tmp/lockfile-pid_test", {wait: 100}).then((unlock) => {
//         console.log(count);
//         fs.writeFileSync("/tmp/lockfile-pid_test.data", count--);
//         setTimeout(() => {
//             unlock();
//             if (!count)
//                 process.exit();
//             setTimeout(go, 500);
//         }, 500);
//     }, (err) => {
//         console.log("Couldn't lock", err);
//         setTimeout(go, 1000);
//     });
// };
// go();
lockfile.lock("/tmp/lockfile-crap", {wait: 100}).then((unlock) => {
    console.log("got lock");
    setTimeout(unlock, 100000);
});

process.on('unhandledRejection', (reason, p) => {
    console.error(reason, 'Unhandled Rejection at Promise', p);
}).on('uncaughtException', err => {
    console.error(err, 'Uncaught Exception thrown');
    process.exit(1);
});
