# requests: raise_for_status() does not raise on 404

repo: psf/requests

`requests.get("https://httpbin.org/status/404").raise_for_status()` returns None instead of raising HTTPError.
Expected: requests.exceptions.HTTPError. requests 2.32.
