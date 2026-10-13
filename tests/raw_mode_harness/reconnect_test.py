import socket, struct, sys, time
PORT = 18495
def listen():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", PORT)); s.listen(4); return s
def read_frames(c, seconds):
    c.settimeout(2.0); n = 0
    end = time.time() + seconds
    try:
        while time.time() < end:
            hdr = b""
            while len(hdr) < 4:
                b = c.recv(4-len(hdr))
                if not b: raise EOFError
                hdr += b
            ln = struct.unpack(">I", hdr)[0]
            p = b""
            while len(p) < ln:
                b = c.recv(ln-len(p))
                if not b: raise EOFError
                p += b
            assert p[:2] == b"\xff\xd8" and p[-2:] == b"\xff\xd9"
            n += 1
    except Exception as e:
        print("  read stopped after %d frames (%r)" % (n, e))
    return n

s1 = listen(); s1.settimeout(8)
c1, _ = s1.accept(); print("PHASE A: connected")
# Note: this harness only presents frames once its own startup checks are done, so
# phase A is here to prove the connection exists, not to count frames. Frames after
# the restart are what prove the link was rebuilt and is usable.
n1 = read_frames(c1, 1.0); print("PHASE A: %d frames before the server went away" % n1)
c1.close(); s1.close()          # the server dies
print("PHASE B: server down for 2s")
time.sleep(2.0)
s2 = listen(); s2.settimeout(8)
c2, _ = s2.accept(); print("PHASE C: reconnected")
n2 = read_frames(c2, 2.0); print("PHASE C: %d frames after the server came back" % n2)
c2.close(); s2.close()
ok = n2 >= 3
print("RESULT", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
