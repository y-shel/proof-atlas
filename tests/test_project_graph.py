import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'experiments/native-extraction/Fixtures.lean'
sys.path.insert(0, str(ROOT / 'scripts'))
from export_evidence import export_evidence


def resolve(value, path):
    for part in path:
        value = value[part]
    return value


class ProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('project_graph', ROOT / 'scripts/project_graph.py')
        cls.api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.api)
        cls.evidence = export_evidence(FIXTURE, ['localFact', 'branches', 'termOnly', 'repeated'])
        cls.source = FIXTURE.read_bytes()
        cls.graph = cls.api.project_graph(cls.evidence, cls.source)

    def test_repeated_execution_and_raw_coverage(self):
        graph = self.graph
        self.api.validate_graph(graph, self.evidence, self.source)
        records = self.evidence['records']
        exact = [r for r in records.values() if r['declarationId'] == 'repeated' and r.get('syntaxKind') == 'Lean.Parser.Tactic.exact']
        chunks = [c for c in graph['chunks'] if c.get('text') == 'exact hp' and c['declarationId'] == 'repeated']
        self.assertEqual(len(chunks), 1)
        self.assertEqual(set(chunks[0]['occurrenceIds']), {r['id'] for r in exact})
        snapshots = [self.evidence['goalSnapshots'][r['beforeGoalSnapshotIds'][0]] for r in exact]
        self.assertEqual(len({s['goalId'] for s in snapshots}), 2)
        nodes = graph['nodes']
        for record in records.values():
            self.assertIn('occurrence:' + record['id'], nodes)
            for child in record['childIds']:
                self.assertTrue(any(e['kind'] == 'contains' and e['source'] == 'occurrence:' + record['id'] and e['target'] == 'occurrence:' + child for e in graph['edges']))
        for record, snapshot in zip(exact, snapshots):
            self.assertTrue(any(e['kind'] == 'has_input_state' and e['source'] == 'occurrence:' + record['id'] and e['target'] == 'snapshot:' + snapshot['id'] for e in graph['edges']))
            self.assertIn('snapshot:' + snapshot['id'], nodes)
            self.assertIn('goal:' + snapshot['goalId'], nodes)
        covered = {r for c in graph['chunks'] for r in c['occurrenceIds']}
        expected = {r['id'] for r in records.values() if r['kind'] in ('tactic', 'term', 'partialTerm')}
        self.assertEqual(covered, expected)
        unsupported = [r for r in records.values() if r.get('payloadStatus') == 'unsupported']
        self.assertTrue(unsupported)
        for record in unsupported:
            self.assertEqual(nodes['occurrence:' + record['id']]['data'], record)
        self.assertTrue(any(not c['defaultVisible'] for c in graph['chunks']))
        by_groups = [c for c in graph['chunks'] if c['syntaxKind'] == 'by']
        self.assertTrue(by_groups)
        self.assertTrue(all(not c['defaultVisible'] for c in by_groups))
        self.assertFalse({'solves', 'depends_on', 'necessary_premise'} & {e['kind'] for e in graph['edges']})

    def test_term_chunks_and_declaration_expressions(self):
        chunks = [c for c in self.graph['chunks'] if c['declarationId'] == 'termOnly']
        self.assertTrue(any(c['kind'] == 'term' for c in chunks))
        self.assertFalse(any(c['kind'] == 'tactic' for c in chunks))
        decl = next(d for d in self.evidence['declarations'] if d['id'] == 'termOnly')
        for field in ('typeExpressionId', 'valueExpressionId'):
            self.assertTrue(any(e['kind'] == 'has_expression' and e['source'] == 'declaration:termOnly' and e['target'] == 'expression:' + decl[field] for e in self.graph['edges']))

    def test_reference_witnesses_resolve_native_constructors(self):
        for kind, tag, key, prefix in [('references_local', 'fvar', 'symbolId', 'symbol:'), ('references_constant', 'const', 'name', 'constant:')]:
            edges = [e for e in self.graph['edges'] if e['kind'] == kind]
            self.assertTrue(edges)
            for edge in edges:
                constructor = resolve(self.evidence, edge['witness']['path'])
                self.assertEqual(constructor['tag'], tag)
                target = self.graph['nodes'][edge['target']]
                if tag == 'fvar':
                    self.assertEqual(edge['target'], prefix + constructor[key])
                    expression = self.evidence['expressions'][self.graph['nodes'][edge['source']]['evidenceId']]
                    context = self.evidence['contexts'][expression['contextId']]
                    self.assertIn(constructor[key], [v['symbolId'] for v in context['locals']])
                else:
                    self.assertEqual(target['name'], constructor[key])

    def test_tampering_rejected(self):
        edges = self.graph['edges']
        for kind in {e['kind'] for e in edges}:
            index = next(i for i, e in enumerate(edges) if e['kind'] == kind)
            broken = copy.deepcopy(self.graph)
            broken['edges'][index]['witness']['path'] = ['records', 'absent']
            with self.subTest(kind=kind), self.assertRaises(self.api.GraphError):
                self.api.validate_graph(broken, self.evidence, self.source)
        local_index = next(i for i, e in enumerate(edges) if e['kind'] == 'references_local')
        original = edges[local_index]
        other = next(n for n, v in self.graph['nodes'].items() if v['kind'] == 'symbol' and n != original['target'])
        broken = copy.deepcopy(self.graph)
        broken['edges'][local_index]['target'] = other
        with self.assertRaises(self.api.GraphError):
            self.api.validate_graph(broken, self.evidence, self.source)
        broken = copy.deepcopy(self.graph)
        broken['edges'][local_index]['source'] = next(n for n, v in self.graph['nodes'].items() if v['kind'] == 'expression' and n != original['source'])
        with self.assertRaises(self.api.GraphError):
            self.api.validate_graph(broken, self.evidence, self.source)
        for section in ('nodes', 'chunks', 'evidence'):
            broken = copy.deepcopy(self.graph)
            if section == 'nodes':
                broken[section].pop(next(iter(broken[section])))
            elif section == 'chunks':
                broken[section][0]['text'] = 'invented text'
            else:
                broken[section]['capabilities']['goalAssignments'] = True
            with self.subTest(section=section), self.assertRaises(self.api.GraphError):
                self.api.validate_graph(broken, self.evidence, self.source)

    def test_determinism_immutability_and_source_mismatch(self):
        before = copy.deepcopy(self.evidence)
        second = self.api.project_graph(self.evidence, self.source)
        self.assertEqual(json.dumps(self.graph, ensure_ascii=False), json.dumps(second, ensure_ascii=False))
        self.assertEqual(self.evidence, before)
        self.assertEqual(self.graph['evidence'], self.evidence)
        self.assertEqual(self.graph['limitations']['capabilities'], self.evidence['capabilities'])
        self.assertEqual(self.graph['source']['text'], self.source.decode())
        with self.assertRaises(self.api.GraphError):
            self.api.project_graph(self.evidence, self.source + b' ')
        with self.assertRaises(self.api.GraphError):
            self.api.validate_graph(self.graph, self.evidence, self.source + b' ')

    def test_unicode_shadowing_and_unused_hypothesis(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'Unicode.lean'
            source.write_text('import Lean\ntheorem unicode (π : Prop) (unused : True) (h : π) : π := by\n  focus\n    have h : π := h\n    exact h\n')
            evidence = export_evidence(source, ['unicode'])
            graph = self.api.project_graph(evidence, source.read_bytes())
            self.api.validate_graph(graph, evidence, source.read_bytes())
            locals_ = [v for c in evidence['contexts'].values() for v in c['locals']]
            unused = {v['symbolId'] for v in locals_ if v['displayNameText'] == 'unused'}
            self.assertTrue(unused)
            # Lean captures the binder's declaration-site fvar too. It is a real reference.
            binder_expressions = {'expression:' + r['expressionId'] for r in evidence['records'].values() if r.get('isBinder') and r.get('expressionId')}
            unused_refs = [e for e in graph['edges'] if e['kind'] == 'references_local' and e['target'] in {'symbol:' + s for s in unused}]
            self.assertTrue(unused_refs)
            self.assertTrue(all(e['source'] in binder_expressions for e in unused_refs))
            focuses = [c for c in graph['chunks'] if c['syntaxKind'] == 'Lean.Parser.Tactic.focus' and c['source']['classification'] == 'original']
            self.assertTrue(focuses)
            self.assertTrue(all(c['defaultVisible'] for c in focuses))
            shadowed = {v['symbolId'] for v in locals_ if v['displayNameText'] == 'h'}
            self.assertGreaterEqual(len(shadowed), 2)
            self.assertTrue(all('symbol:' + s in graph['nodes'] for s in shadowed))
            for chunk in graph['chunks']:
                if chunk['source']['startByte'] is not None:
                    span = chunk['source']
                    self.assertEqual(chunk['text'], source.read_bytes()[span['startByte']:span['endByte']].decode())
            self.assertTrue(any(c['text'] == 'exact h' for c in graph['chunks']))

    def test_cli_requires_source_and_writes_valid_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence_path = Path(directory) / 'evidence.json'
            output = Path(directory) / 'graph.json'
            evidence_path.write_text(json.dumps(self.evidence))
            command = [sys.executable, str(ROOT / 'scripts/project_graph.py'), str(evidence_path), '--output', str(output)]
            result = subprocess.run(command, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            result = subprocess.run(command + ['--source', str(FIXTURE)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.api.validate_graph(json.loads(output.read_text()), self.evidence, self.source)


if __name__ == '__main__':
    unittest.main()
