# json.dumps silently emits invalid JSON for NaN

repo: python/cpython

`json.dumps(float("nan"))` returns the string `NaN`, which is not valid JSON (RFC 8259 has no NaN).
I expected it to raise ValueError so invalid JSON never leaves my service.

Python 3.13, standard library only.
