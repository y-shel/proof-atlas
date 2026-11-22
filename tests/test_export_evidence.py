import json
import copy
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'experiments/native-extraction/Fixtures.lean'


class ExportTests(unittest.TestCase):
    def export(self, source=FIXTURE, names=('localFact', 'branches', 'termOnly', 'repeated')):
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / 'evidence.json'
            command = [sys.executable, str(ROOT / 'scripts/export_evidence.py'), str(source), '--output', str(output)]
            for name in names:
                command += ['--declaration', name]
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(output.read_text()), output.read_bytes()

    def test_fixture_evidence_and_reproducibility(self):
        data, first = self.export()
        self.assertEqual(first, self.export()[1])
        self.assertEqual(data['schemaVersion'], 'proof-atlas.evidence.v0')
        records = data['records']
        exact = [r for r in records.values() if r.get('syntaxKind') == 'Lean.Parser.Tactic.exact' and r['declarationId'] == 'repeated']
        self.assertEqual(len(exact), 2)
        self.assertEqual([r['source']['startByte'] for r in exact], [389, 389])
        self.assertNotEqual(exact[0]['id'], exact[1]['id'])
        inputs = [data['goalSnapshots'][r['beforeGoalSnapshotIds'][0]] for r in exact]
        self.assertNotEqual(inputs[0]['goalId'], inputs[1]['goalId'])
        term_records = [r for r in records.values() if r['declarationId'] == 'termOnly']
        self.assertTrue(any(r['kind'] == 'term' for r in term_records))
        self.assertFalse(any(r['kind'] == 'tactic' for r in term_records))
        self.assertIsNotNone(data['declarations'][2]['valueExpressionId'])
        local = next(r for r in records.values() if r.get('syntaxKind') == 'Lean.Parser.Tactic.exact' and r['declarationId'] == 'localFact')
        snapshot = data['goalSnapshots'][local['beforeGoalSnapshotIds'][0]]
        context = data['contexts'][snapshot['contextId']]
        self.assertEqual([v['displayNameText'] for v in context['locals']], ['localFact', 'p', 'q', 'hp', 'h'])
        self.assertTrue(snapshot['targetExpressionId'] in data['expressions'])
        self.assertEqual(data['capabilities']['goalAssignments'], 'unavailable')
        self.assertEqual(data['declarations'][0]['proofStatus']['transitiveTrust'], 'unscanned')
        self.assertNotIn('_uniq.', first.decode())
        boundary = runpy.run_path(str(ROOT / 'scripts/export_evidence.py'))
        broken = copy.deepcopy(data)
        broken['goalSnapshots'][inputs[0]['id']]['targetExpressionId'] = 'missing'
        with self.assertRaises(boundary['EvidenceError']):
            boundary['validate_evidence'](broken, FIXTURE.read_bytes())
        broken = copy.deepcopy(data)
        target = broken['expressions'][snapshot['targetExpressionId']]
        scope = {v['symbolId'] for v in data['contexts'][target['contextId']]['locals']}
        outside = next(symbol for symbol in data['symbols'] if symbol not in scope)
        target['expression'] = {'tag': 'fvar', 'symbolId': outside, 'binderDepth': 0}
        with self.assertRaises(boundary['EvidenceError']):
            boundary['validate_evidence'](broken, FIXTURE.read_bytes())
        broken = copy.deepcopy(data)
        broken['records'][exact[0]['parentId']]['childIds'].remove(exact[0]['id'])
        with self.assertRaises(boundary['EvidenceError']):
            boundary['validate_evidence'](broken, FIXTURE.read_bytes())
        broken = copy.deepcopy(data)
        broken['infoRoots'].pop()
        with self.assertRaises(boundary['EvidenceError']):
            boundary['validate_evidence'](broken, FIXTURE.read_bytes())

    def test_unicode_and_shadowing(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'Unicode.lean'
            source.write_text('import Lean\ntheorem unicode (π : Prop) (h : π) : π := by\n  have h : π := h\n  exact h\n')
            data, _ = self.export(source, ('unicode',))
            exact = [r for r in data['records'].values() if r.get('syntaxKind') == 'Lean.Parser.Tactic.exact']
            self.assertEqual(len(exact), 1)
            span = exact[0]['source']
            self.assertEqual(source.read_bytes()[span['startByte']:span['endByte']], b'exact h')
            symbols = {v['symbolId'] for c in data['contexts'].values() for v in c['locals'] if v['displayNameText'] == 'h'}
            self.assertGreaterEqual(len(symbols), 2)

    def test_unknown_declaration_and_invalid_source_fail(self):
        with tempfile.TemporaryDirectory() as d:
            invalid = Path(d) / 'Invalid.lean'
            invalid.write_text('theorem broken : False := by exact True.intro\n')
            for source, name in [(FIXTURE, 'missing'), (invalid, 'broken')]:
                output = Path(d) / 'out.json'
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/export_evidence.py'), str(source), '--declaration', name, '--output', str(output)], cwd=ROOT, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())

    def test_depth_limit_and_imported_selection_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'Deep.lean'
            source.write_text('set_option maxRecDepth 10000\nset_option maxHeartbeats 10000000\ndef deep : Nat := ' + 'Nat.succ (' * 550 + '0' + ')' * 550 + '\n')
            output = Path(d) / 'out.json'
            for path, name, message in [(source, 'deep', b'capture limit'), (FIXTURE, 'And.intro', b'no source information')]:
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/export_evidence.py'), str(path), '--declaration', name, '--output', str(output)], cwd=ROOT, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(output.exists())

    def test_large_natural_literal_is_exact(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'Large.lean'
            source.write_text('def large : Nat := 9007199254740993\n')
            data, _ = self.export(source, ('large',))
            eid = data['declarations'][0]['valueExpressionId']
            def nodes(value):
                if isinstance(value, dict):
                    yield value
                    for child in value.values():
                        yield from nodes(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from nodes(child)
            literals = [n['value'] for n in nodes(data['expressions'][eid]) if n.get('tag') == 'lit' and n.get('kind') == 'nat']
            self.assertIn('9007199254740993', literals)

    def test_admission_is_visible(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'Admission.lean'
            source.write_text('theorem admitted : False := by sorry\n')
            data, _ = self.export(source, ('admitted',))
            self.assertTrue(data['declarations'][0]['proofStatus']['containsSorry'])
            self.assertTrue(data['diagnostics'])


if __name__ == '__main__':
    unittest.main()
