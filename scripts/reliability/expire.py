#!/usr/bin/env python3
"""Expire only the lab that created this watchdog; never tear down a newer lab."""
import sys
import fcntl
import time
import lab
owner, seconds = sys.argv[1], int(sys.argv[2])
deadline=time.monotonic()+seconds
while time.monotonic()<deadline:
    if not lab.STATE.exists() or lab.load()['owner']!=owner:
        sys.exit(0)
    time.sleep(min(30,max(0,deadline-time.monotonic())))
with (lab.ROOT/'controller.lock').open('w') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if lab.STATE.exists() and lab.load()['owner']==owner:
        state=lab.load()
        state['processes'].pop('expiry',None)
        lab.save(state)
        lab.down(None)
