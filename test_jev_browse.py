"""Offline tests for jev-browse: span extraction, question construction, and the code-owned gates."""
import importlib.util
import os
import sys
import unittest

spec = importlib.util.spec_from_file_location("jb", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev-browse.py"))
jb = importlib.util.module_from_spec(spec)
sys.modules["jb"] = jb
spec.loader.exec_module(jb)

PAGE = {"url": "u", "title": "t", "text": "", "elements": [
    {"id": "e1", "role": "link", "name": "Log in"},
    {"id": "e2", "role": "searchbox", "name": "Search Wikipedia"},
    {"id": "e3", "role": "link", "name": "Donate"}]}


class Spans(unittest.TestCase):
    def test_quoted_text_comes_first_and_stopwords_are_dropped(self):
        s = jb.goal_spans("Search Wikipedia for 'Reinforcement learning' and open the article")
        self.assertEqual(s[0], "Reinforcement learning")
        self.assertIn("Reinforcement", s)
        self.assertNotIn("the", s)
        self.assertEqual(len(s), len(set(x.lower() for x in s)))


class Questions(unittest.TestCase):
    def test_speculative_heads_exist_only_when_their_targets_do(self):
        q, aux = jb.build_questions("Search for 'x'", PAGE, [], set())
        self.assertEqual(sorted(q["click_target"]["criteria"]), ["e1", "e3"])
        self.assertEqual(list(q["type_target"]["criteria"]), ["e2"])
        self.assertIn("NONE", q["type_text"]["criteria"])
        self.assertEqual(aux["spans"][0], "x")
        page = {**PAGE, "elements": [PAGE["elements"][1]]}       # nothing clickable
        q, _ = jb.build_questions("g", page, [], set())
        self.assertNotIn("click_target", q)
        self.assertNotIn("CLICK", q["operation"]["criteria"])

    def test_done_is_always_asked_twice_independently(self):
        q, _ = jb.build_questions("g", PAGE, [], set())
        self.assertEqual(q["done"]["type"], "noul")
        self.assertIn("DONE", q["operation"]["criteria"])

    def test_banned_target_is_not_offered_again(self):
        q, _ = jb.build_questions("g", PAGE, [], {"e1"})
        self.assertEqual(list(q["click_target"]["criteria"]), ["e3"])

    def test_wait_is_withdrawn_after_a_wait_that_changed_nothing(self):
        q, _ = jb.build_questions("g", PAGE, [{"operation": "WAIT", "page_changed": False}], set())
        self.assertNotIn("WAIT", q["operation"]["criteria"])
        q, _ = jb.build_questions("g", PAGE, [{"operation": "WAIT", "page_changed": True}], set())
        self.assertIn("WAIT", q["operation"]["criteria"])

    def test_done_is_withdrawn_after_the_independent_check_rejected_it(self):
        q, _ = jb.build_questions("g", PAGE, [{"operation": "WAIT", "done_rejected": True}], set())
        self.assertNotIn("DONE", q["operation"]["criteria"])

    def test_untrusted_page_text_is_stated_in_the_rules(self):
        self.assertIn("untrusted data", jb.RULES)


class StopGate(unittest.TestCase):
    """Ending a run takes two signals that agree. One head saying so is a claim, not evidence."""

    def setUp(self):
        self.captured = []

    def answer(self, operation, probabilities, done=0.02, blocked=0.02, targets=True):
        def fake_decide(state, questions):
            self.captured.append(questions)
            a = {"operation": {"choice": operation, "probabilities": probabilities, "confidence": 0.8},
                 "done": {"type": "noul", "noul": done},
                 "blocked": {"type": "noul", "noul": blocked}}
            if targets:
                for head in ("click_target", "type_target", "type_text"):
                    if head in questions:
                        ids = list(questions[head]["criteria"])
                        a[head] = {"choice": ids[0], "confidence": 0.7,
                                   "probabilities": {i: float(i == ids[0]) for i in ids}}
            return {"answers": a, "_latency_ms": 10, "usage": {}}
        return fake_decide

    def test_blocked_is_asked_independently_too(self):
        q, _ = jb.build_questions("g", PAGE, [], set())
        self.assertEqual(q["blocked"]["type"], "noul")
        self.assertIn("BLOCKED", q["operation"]["criteria"])

    def test_blocked_is_withdrawn_after_the_independent_check_rejected_it(self):
        q, _ = jb.build_questions("g", PAGE, [{"operation": "WAIT", "blocked_rejected": True}], set())
        self.assertNotIn("BLOCKED", q["operation"]["criteria"])
        self.assertIn("DONE", q["operation"]["criteria"])

    def test_a_rejected_done_runs_the_runner_up_instead_of_burning_a_step_on_wait(self):
        jb.decide = self.answer("DONE", {"DONE": 0.6, "CLICK": 0.3, "WAIT": 0.1}, done=0.05)
        d = jb.decide_step("g", PAGE, [], set())
        self.assertTrue(d["done_rejected"])
        self.assertEqual(d["operation"], "CLICK")
        self.assertEqual(d["target"], "e1")     # Already answered speculatively in the same request.

    def test_a_rejected_blocked_runs_the_runner_up(self):
        jb.decide = self.answer("BLOCKED", {"BLOCKED": 0.41, "CLICK": 0.26, "SCROLL_DOWN": 0.33}, blocked=0.15)
        d = jb.decide_step("g", PAGE, [], set())
        self.assertTrue(d["blocked_rejected"])
        self.assertEqual(d["operation"], "SCROLL_DOWN")

    def test_a_stop_both_signals_agree_on_still_stops(self):
        jb.decide = self.answer("DONE", {"DONE": 1.0}, done=0.97)
        self.assertEqual(jb.decide_step("g", PAGE, [], set())["operation"], "DONE")
        jb.decide = self.answer("BLOCKED", {"BLOCKED": 1.0}, blocked=0.93)
        self.assertEqual(jb.decide_step("g", PAGE, [], set())["operation"], "BLOCKED")

    def test_with_nothing_able_to_act_a_rejected_stop_stays_blocked(self):
        jb.decide = self.answer("DONE", {"DONE": 1.0, "BLOCKED": 0.0}, done=0.01)
        self.assertEqual(jb.decide_step("g", PAGE, [], set())["operation"], "BLOCKED")


class AnswerValidation(unittest.TestCase):
    """A target the page never offered must never reach the browser."""

    def fake(self, answers):
        return lambda state, questions: {"answers": answers, "_latency_ms": 1, "usage": {}}

    def base(self, **over):
        a = {"operation": {"choice": "CLICK", "probabilities": {"CLICK": 1.0}, "confidence": 0.9},
             "done": {"type": "noul", "noul": 0.01}, "blocked": {"type": "noul", "noul": 0.01},
             "click_target": {"choice": "e1", "probabilities": {"e1": 0.7, "e3": 0.3}, "confidence": 0.8}}
        a.update(over)
        return a

    def test_an_invented_target_is_rejected(self):
        jb.decide = self.fake(self.base(click_target={"choice": "e99", "probabilities": {"e99": 1.0}}))
        with self.assertRaises(jb.JevError):
            jb.decide_step("g", PAGE, [], set())

    def test_a_distribution_that_does_not_sum_to_one_is_rejected(self):
        jb.decide = self.fake(self.base(click_target={"choice": "e1", "probabilities": {"e1": 0.2, "e3": 0.2}}))
        with self.assertRaises(jb.JevError):
            jb.decide_step("g", PAGE, [], set())

    def test_a_choice_that_is_not_the_most_likely_option_is_rejected(self):
        jb.decide = self.fake(self.base(click_target={"choice": "e1", "probabilities": {"e1": 0.3, "e3": 0.7}}))
        with self.assertRaises(jb.JevError):
            jb.decide_step("g", PAGE, [], set())

    def test_a_route_that_reports_no_distribution_still_works(self):
        jb.decide = self.fake(self.base(click_target={"choice": "e1", "confidence": 0.8}))
        self.assertEqual(jb.decide_step("g", PAGE, [], set())["target"], "e1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
