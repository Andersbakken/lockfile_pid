#!/usr/bin/perl
# emulate linux flock command line utility
#
use warnings;
use strict;
use Fcntl qw(:flock);
# line buffer
$|=1;

my $file = shift;

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
# print STDOUT "FUCK " . $ret . " " . $errors . "\n";
eval {
    print STDOUT "LOCKED\n";
    local $SIG{ALRM} = sub { print STDERR "GOT ALARM!\n" };
    sleep;
};
print STDERR "UNLOCKING\n";
flock(FH, LOCK_UN);
print STDERR "UNLOCKED\n";
