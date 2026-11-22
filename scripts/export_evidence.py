#!/usr/bin/env python3
"""Export selected Lean declarations as deterministic native evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
TOOLCHAIN = (ROOT / 'lean-toolchain').read_text().strip()
TABLES = ('records', 'contexts', 'expressions', 'goalSnapshots', 'goals', 'symbols', 'universeMetavariables')


class EvidenceError(ValueError):
    pass


def validate_evidence(data: dict, source: bytes) -> None:
    """Reject broken references, invalid scopes, and out-of-bounds source ranges."""
    def ref(table, value):
        if value is not None and value not in data[table]:
            raise EvidenceError(f'Unknown {table} reference: {value}')

    def expression(node, scope, depth=0):
        tag = node.get('tag')
        if tag == 'fvar':
            ref('symbols', node['symbolId'])
            if node['symbolId'] not in scope:
                raise EvidenceError('Free variable outside expression context')
        if tag == 'mvar':
            ref('goals', node['goalId'])
        if tag == 'bvar' and node['index'] >= depth:
            raise EvidenceError('Loose bound variable')
        for key, value in node.items():
            if isinstance(value, dict) and 'binderDepth' in value:
                expression(value, scope, depth + (key == 'body' and tag in ('lam', 'forallE', 'letE')))

    for root in data['infoRoots']:
        ref('records', root)
        if data['records'][root]['parentId'] is not None:
            raise EvidenceError('Root has a parent')
    for record in data['records'].values():
        ref('records', record['parentId'])
        ref('contexts', record['contextId'])
        if record['parentId'] is not None and record['id'] not in data['records'][record['parentId']]['childIds']:
            raise EvidenceError('Record missing from declared parent')
        for child in record['childIds']:
            ref('records', child)
            if data['records'][child]['parentId'] != record['id']:
                raise EvidenceError('Inconsistent information-tree parent')
        if record['declarationId'] not in {d['id'] for d in data['declarations']}:
            raise EvidenceError('Unknown declaration reference')
        for key in ('beforeGoalSnapshotIds', 'afterGoalSnapshotIds'):
            for snapshot in record.get(key, []):
                ref('goalSnapshots', snapshot)
                if data['goalSnapshots'][snapshot]['actionRecordId'] != record['id']:
                    raise EvidenceError('Snapshot belongs to another action')
        for key in ('expressionId', 'expectedTypeId'):
            ref('expressions', record.get(key))
        for key in ('symbolId', 'baseSymbolId'):
            ref('symbols', record.get(key))
        if 'source' in record:
            start, end = record['source']['startByte'], record['source']['endByte']
            if (start is None) != (end is None):
                raise EvidenceError('Incomplete source range')
            if start is not None:
                if not 0 <= start <= end <= len(source):
                    raise EvidenceError('Source range outside pinned bytes')
                source[:start].decode('utf-8')
                source[:end].decode('utf-8')
    pending = list(data['infoRoots'])
    reached = set()
    while pending:
        record_id = pending.pop()
        if record_id in reached:
            raise EvidenceError('Repeated or cyclic information occurrence')
        reached.add(record_id)
        pending.extend(data['records'][record_id]['childIds'])
    if reached != set(data['records']):
        raise EvidenceError('Information occurrence unreachable from roots')
    for snapshot in data['goalSnapshots'].values():
        for table, key in [('goals', 'goalId'), ('records', 'actionRecordId'), ('contexts', 'contextId'), ('expressions', 'targetExpressionId')]:
            ref(table, snapshot[key])
        if data['expressions'][snapshot['targetExpressionId']]['contextId'] != snapshot['contextId']:
            raise EvidenceError('Snapshot target has another context')
    for context in data['contexts'].values():
        prefix = set()
        for local in context['locals']:
            ref('symbols', local['symbolId'])
            for key in ('typeExpressionId', 'valueExpressionId'):
                ref('expressions', local[key])
                if local[key] is not None:
                    expr = data['expressions'][local[key]]
                    if expr['contextId'] != context['id']:
                        raise EvidenceError('Local expression has another context')
                    expression(expr['expression'], prefix)
            prefix.add(local['symbolId'])
    for expr in data['expressions'].values():
        ref('contexts', expr['contextId'])
        scope = {v['symbolId'] for v in data['contexts'][expr['contextId']]['locals']}
        expression(expr['expression'], scope)
    def levels(value):
        if isinstance(value, dict):
            if 'universeId' in value:
                ref('universeMetavariables', value['universeId'])
            for child in value.values():
                levels(child)
        elif isinstance(value, list):
            for child in value:
                levels(child)

    levels(data['expressions'])
    for decl in data['declarations']:
        ref('expressions', decl['typeExpressionId'])
        ref('expressions', decl['valueExpressionId'])


def export_evidence(source: Path, declarations: list[str]) -> dict:
    source = source.resolve()
    if not declarations or len(set(declarations)) != len(declarations):
        raise EvidenceError('Select one or more distinct declaration names')
    content = source.read_bytes()
    command = ['lean', '+' + TOOLCHAIN, '--run', str(ROOT / 'lean/Export.lean'), str(source), *declarations]
    result = subprocess.run(command, cwd=ROOT, env={**os.environ, 'LEAN_PATH': ''}, capture_output=True, text=True, timeout=180)
    if source.read_bytes() != content:
        raise EvidenceError('Source changed during extraction')
    if result.returncode:
        raise EvidenceError((result.stderr or result.stdout).strip())
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise EvidenceError('Lean did not emit a single evidence object: ' + result.stdout[:1000]) from error
    for table in TABLES:
        rows = data[table]
        data[table] = {row['id']: row for row in rows}
        if len(rows) != len(data[table]):
            raise EvidenceError(f'Duplicate {table} identity')
    if any(not any(r['declarationId'] == name for r in data['records'].values()) for name in declarations):
        raise EvidenceError('Selected declaration has no source information in this file')
    try:
        source_path = source.relative_to(ROOT).as_posix()
    except ValueError:
        source_path = source.name
    version = subprocess.run(['lean', '+' + TOOLCHAIN, '--version'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    data.update({
        'schemaVersion': 'proof-atlas.evidence.v0',
        'extractorVersion': '0.1.0',
        'project': {'sourcePath': source_path, 'sourceSha256': hashlib.sha256(content).hexdigest(), 'sourceByteLength': len(content), 'toolchain': TOOLCHAIN, 'leanVersion': version, 'dependencyIdentity': {'status': 'toolchain-only', 'projectDependencies': 'unsupported'}, 'elaborationOptions': {'Elab.async': False}},
        'requestedDeclarations': declarations,
        'captureStatus': 'partial' if any(r['kind'] in ('hole', 'partialTerm') for r in data['records'].values()) else 'complete',
        'capabilities': {'tacticRecords': True, 'termRecords': True, 'sourceClassifications': True, 'structuredExpressions': True, 'diagnostics': True, 'goalAssignments': 'unavailable', 'metavariableContexts': 'snapshot-targets-and-locals-only', 'metadata': 'omitted-with-marker', 'unsupportedInfoPayloads': 'placeholders', 'namespaceOptions': 'unavailable', 'transitiveProofTrust': 'unscanned', 'imports': 'installed-toolchain-only'},
        'captureLimits': {'expressionTraversalDepth': 512, 'universeTraversalDepth': 512, 'onLimit': 'fail', 'projectCoverage': 'core-only-tested'},
    })
    for diagnostic in data['diagnostics']:
        diagnostic['message'] = diagnostic['message'].replace(str(source), source_path)
    validate_evidence(data, content)
    canonical = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    data['artifactId'] = 'sha256:' + hashlib.sha256(canonical).hexdigest()
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--declaration', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        evidence = export_evidence(args.source, args.declaration)
        payload = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
        args.output.write_text(payload, encoding='utf-8')
    except (EvidenceError, OSError, subprocess.SubprocessError) as error:
        print(f'Export failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
