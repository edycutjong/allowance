import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "git+https://github.com/edycutjong/allowance-demo"], check=True)
from pocketkit import parse_duration
actual = parse_duration('1h30m')
if actual != 5400:
    raise AssertionError("REPRODUCED: expected 5400, got " + repr(actual))
print("NOT REPRODUCED")
