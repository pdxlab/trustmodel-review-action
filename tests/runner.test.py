"""Local runner contract: settings never execute, paths only, no fallback pass."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run-trust-review.sh"
source = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.ns = {"__name__": "test_runner"}
        exec(compile(source, str(SCRIPT), "exec"), self.ns)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".trustreviewenv").write_text(
            "TRUSTMODEL_BASE_URL=http://127.0.0.1:8000\nTRUSTMODEL_API_KEY=tm-secret\nGITHUB_TOKEN=gh-secret\n"
            "TRUSTREVIEW_REPO=acme/app\nTRUSTREVIEW_PR=1\nTRUSTREVIEW_POST_GITHUB=true\n")
        self.paths = self.root / "paths.json"
        self.paths.write_text('["agents/run.py"]')
        self.calls = []
        self.result = {"status": "not_available", "passed": False, "pr_diff_evaluated": False, "trust_score": None}
        self.ns["api"] = self.api

    def api(self, url, token, payload=None, **kwargs):
        self.calls.append((url, token, payload))
        if "api.github.com" in url:
            self.assertEqual(token, "gh-secret")
            if "/pulls/" in url:
                return {"state": "open", "head": {"sha": "a"*40}, "base": {"sha": "b"*40}, "changed_files": 1}
            if "/comments" in url and payload is None:
                return []
            return {"id": 42}
        self.assertEqual(token, "tm-secret")
        self.assertNotIn("gh-secret", json.dumps(payload))
        self.assertNotIn("changed_assets", payload)
        self.assertEqual(payload["changed_files"], ["agents/run.py"])
        return self.result

    def run_main(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.ns["main"](["--paths", str(self.paths), *extra], self.root)
        self.assertNotIn("tm-secret", out.getvalue()+err.getvalue())
        self.assertNotIn("gh-secret", out.getvalue()+err.getvalue())
        return code, out.getvalue()

    def test_not_available_publishes_error_and_paths_only(self):
        self.assertEqual(self.run_main()[0], 2)
        writes = [(url, data) for url, _, data in self.calls if data is not None and "api.github.com" in url]
        self.assertIn("/statuses/", writes[0][0])
        self.assertEqual(writes[0][1]["state"], "error")
        self.assertIn("Trust Review — not available", writes[1][1]["body"])

    def test_dry_run_does_not_submit_or_publish(self):
        self.assertEqual(self.run_main("--dry-run")[0], 0)
        self.assertTrue(all(data is None for _, _, data in self.calls))

    def test_malformed_success_body_is_published_as_error(self):
        self.result = []
        self.assertEqual(self.run_main()[0], 3)
        status = next(data for url, _, data in self.calls if "/statuses/" in url)
        self.assertEqual(status["state"], "error")

    def test_legacy_website_pass_is_rejected(self):
        self.result = {"status": "passed", "passed": True, "pr_diff_evaluated": False, "trust_score": 100}
        self.assertEqual(self.run_main()[0], 3)
        status = next(data for url, _, data in self.calls if "/statuses/" in url)
        self.assertEqual(status["state"], "error")

    def test_verified_future_pass_requires_evidence(self):
        self.result = {"status": "passed", "passed": True, "pr_diff_evaluated": True, "trust_score": 90}
        self.assertEqual(self.run_main()[0], 0)

    def test_no_key_never_calls_backend(self):
        p = self.root / ".trustreviewenv"
        p.write_text(p.read_text().replace("TRUSTMODEL_API_KEY=tm-secret", "TRUSTMODEL_API_KEY="))
        self.assertEqual(self.run_main()[0], 2)
        self.assertTrue(all("api.github.com" in url for url, _, _ in self.calls))

    def test_outage_is_published_as_error_without_fallback(self):
        def fail(url, token, payload=None, **kwargs):
            if "api.github.com" not in url:
                raise self.ns["ApiError"](503)
            return self.api(url, token, payload, **kwargs)
        self.ns["api"] = fail
        self.assertEqual(self.run_main()[0], 3)
        status = next(data for url, _, data in self.calls if "/statuses/" in url)
        self.assertEqual(status["state"], "error")
        self.assertTrue(all("site-score" not in url for url, _, _ in self.calls))

    def test_empty_paths_cannot_pass(self):
        self.paths.write_text('[]')
        def empty(url, token, payload=None, **kwargs):
            if "api.github.com" not in url:
                self.assertEqual(payload["changed_files"], [])
                return self.result
            return self.api(url, token, payload, **kwargs)
        self.ns["api"] = empty
        self.assertEqual(self.run_main()[0], 2)

    def test_settings_are_literal_and_assets_objects_are_rejected(self):
        p = self.root / ".trustreviewenv"
        p.write_text('EXAMPLE="$(never-execute)"\n')
        self.assertEqual(self.ns["load_settings"](p)["EXAMPLE"], "$(never-execute)")
        with self.assertRaises(self.ns["ReviewError"]):
            self.ns["validate_paths"]([{"path": "a", "content": "private source"}])


if __name__ == "__main__":
    unittest.main()
