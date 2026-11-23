#!/usr/bin/env python3
"""Project native Lean evidence into a checked graph and source-region groups."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys

from export_evidence import EvidenceError, validate_evidence

SCHEMA = 'proof-atlas.graph.v0'
PROJECTION = '0.1.0'
CHUNK_POLICY = 'source-regions.v0'
TABLE_KINDS = {
    'records': 'occurrence', 'goalSnapshots': 'snapshot', 'goals': 'goal',
    'contexts': 'context', 'symbols': 'symbol', 'expressions': 'expression',
    'universeMetavariables': 'universe',
}
WRAPPERS = {
    'by',
    'Lean.Parser.Term.byTactic', 'Lean.Parser.Tactic.tacticSeq',
    'Lean.Parser.Tactic.tacticSeq1Indented', 'Lean.Parser.Tactic.tacticSeqBracketed',
}


class GraphError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _check_evidence(evidence, source):
    if evidence['schemaVersion'] != 'proof-atlas.evidence.v0':
        raise GraphError('Unsupported evidence schema')
    project = evidence['project']
    if hashlib.sha256(source).hexdigest() != project['sourceSha256'] or len(source) != project['sourceByteLength']:
        raise GraphError('Source bytes do not match evidence SHA-256 and length')
    source.decode('utf-8')
    validate_evidence(evidence, source)
    unsigned = {k: v for k, v in evidence.items() if k != 'artifactId'}
    identity = 'sha256:' + hashlib.sha256(canonical(unsigned).encode('utf-8')).hexdigest()
    if evidence['artifactId'] != identity:
        raise GraphError('Evidence artifact identity does not match its contents')


def _build_graph(evidence, source):
    nodes, edges = {}, []

    def node(kind, identity, path, **attributes):
        key = kind + ':' + identity
        nodes[key] = {'id': key, 'kind': kind, 'evidenceId': identity, 'evidencePath': path, **attributes}
        return key

    def edge(kind, owner, target, path, witness_kind='captured_field'):
        edges.append({'kind': kind, 'source': owner, 'target': target,
                      'witness': {'kind': witness_kind, 'path': path}})

    def field(owner, row, path, field_name, kind, target_kind):
        value = row.get(field_name)
        if value is not None:
            edge(kind, owner, target_kind + ':' + value, path + [field_name])

    for table, kind in TABLE_KINDS.items():
        for identity, row in sorted(evidence[table].items()):
            node(kind, identity, [table, identity], data=copy.deepcopy(row))
    for ordinal, declaration in enumerate(evidence['declarations']):
        path = ['declarations', ordinal]
        owner = node('declaration', declaration['id'], path, data=copy.deepcopy(declaration))
        for name in ('typeExpressionId', 'valueExpressionId'):
            field(owner, declaration, path, name, 'has_expression', 'expression')

    for identity, record in sorted(evidence['records'].items()):
        owner, path = 'occurrence:' + identity, ['records', identity]
        edge('in_declaration', owner, 'declaration:' + record['declarationId'], path + ['declarationId'])
        for ordinal, child in enumerate(record['childIds']):
            edge('contains', owner, 'occurrence:' + child, path + ['childIds', ordinal])
        for name, kind in [('beforeGoalSnapshotIds', 'has_input_state'), ('afterGoalSnapshotIds', 'has_output_state')]:
            for ordinal, snapshot in enumerate(record.get(name, [])):
                edge(kind, owner, 'snapshot:' + snapshot, path + [name, ordinal])
        field(owner, record, path, 'contextId', 'has_context', 'context')
        for name in ('expressionId', 'expectedTypeId'):
            field(owner, record, path, name, 'has_expression', 'expression')
        for name in ('symbolId', 'baseSymbolId'):
            field(owner, record, path, name, 'records_symbol', 'symbol')

    for identity, snapshot in sorted(evidence['goalSnapshots'].items()):
        owner, path = 'snapshot:' + identity, ['goalSnapshots', identity]
        field(owner, snapshot, path, 'goalId', 'has_goal_identity', 'goal')
        field(owner, snapshot, path, 'contextId', 'has_context', 'context')
        field(owner, snapshot, path, 'targetExpressionId', 'has_expression', 'expression')

    for identity, context in sorted(evidence['contexts'].items()):
        for ordinal, local in enumerate(context['locals']):
            path = ['contexts', identity, 'locals', ordinal]
            owner = node('local', identity + '/' + str(ordinal), path, data=copy.deepcopy(local))
            edge('has_local', 'context:' + identity, owner, path)
            field(owner, local, path, 'symbolId', 'has_symbol_identity', 'symbol')
            for name in ('typeExpressionId', 'valueExpressionId'):
                field(owner, local, path, name, 'has_expression', 'expression')

    def references(value, path, owner):
        if not isinstance(value, dict):
            return
        if value.get('tag') == 'fvar':
            edge('references_local', owner, 'symbol:' + value['symbolId'], path, 'expression_constructor')
        elif value.get('tag') == 'const':
            name = value['name']
            identity = hashlib.sha256(canonical(name).encode('utf-8')).hexdigest()
            key = 'constant:' + identity
            if key not in nodes:
                node('constant', identity, path + ['name'], name=copy.deepcopy(name))
            edge('references_constant', owner, key, path, 'expression_constructor')
        for name, child in value.items():
            if isinstance(child, dict) and 'binderDepth' in child:
                references(child, path + [name], owner)

    for identity, expression in sorted(evidence['expressions'].items()):
        owner, path = 'expression:' + identity, ['expressions', identity]
        field(owner, expression, path, 'contextId', 'has_context', 'context')
        references(expression['expression'], path + ['expression'], owner)

    groups = {}
    for identity, record in sorted(evidence['records'].items()):
        if record['kind'] not in ('tactic', 'term', 'partialTerm'):
            continue
        span = record.get('source') or {'classification': 'missing', 'startByte': None, 'endByte': None}
        original = span['classification'] == 'original' and span['startByte'] is not None
        wrapper = record.get('syntaxKind') in WRAPPERS
        policy = 'structural-wrapper' if wrapper else 'source-action' if original else 'synthetic-or-missing-source'
        key = canonical([record['declarationId'], record['kind'], record.get('syntaxKind'), span, policy])
        if key not in groups:
            groups[key] = {
                'id': 'chunk:' + hashlib.sha256(key.encode('utf-8')).hexdigest(),
                'policyVersion': CHUNK_POLICY, 'kind': 'term' if record['kind'] == 'partialTerm' else record['kind'],
                'declarationId': record['declarationId'], 'syntaxKind': record.get('syntaxKind'),
                'source': copy.deepcopy(span), 'occurrenceIds': [],
                'defaultVisible': original and not wrapper,
                'groupingReason': 'same declaration, record kind, syntax kind and exact source provenance/range',
                'visibilityReason': policy,
                'text': source[span['startByte']:span['endByte']].decode('utf-8') if span['startByte'] is not None else None,
            }
        groups[key]['occurrenceIds'].append(identity)

    edges.sort(key=canonical)
    for ordinal, item in enumerate(edges):
        item['id'] = 'edge:' + str(ordinal)
    return {
        'schemaVersion': SCHEMA, 'projectionVersion': PROJECTION, 'artifactId': evidence['artifactId'],
        'chunkPolicyVersion': CHUNK_POLICY, 'idScope': 'artifact-local',
        'source': {**copy.deepcopy(evidence['project']), 'verified': True, 'text': source.decode('utf-8')},
        'evidence': copy.deepcopy(evidence), 'nodes': dict(sorted(nodes.items())), 'edges': edges,
        'chunks': [groups[key] for key in sorted(groups)],
        'limitations': {
            'captureStatus': evidence['captureStatus'], 'capabilities': copy.deepcopy(evidence['capabilities']),
            'captureLimits': copy.deepcopy(evidence['captureLimits']),
            'references': 'syntactic occurrences only; context presence does not establish use or necessity',
            'goals': 'snapshots only; disappearance does not establish solving or producer/consumer dependencies',
            'chunks': 'source-region view only; not execution identities or a unique mathematical partition',
            'order': 'record hierarchy and snapshot ordinals only; no universal execution order',
            'defaultHidden': 'structural wrappers and synthetic/missing source remain in raw evidence and chunks',
        },
    }


def project_graph(evidence: dict, source: bytes) -> dict:
    """Return a deterministic graph without modifying evidence or inferring proof use."""
    try:
        _check_evidence(evidence, source)
        return _build_graph(evidence, source)
    except (EvidenceError, KeyError, TypeError, UnicodeError, RecursionError) as error:
        raise GraphError(f'Invalid projection input: {error}') from error


def validate_graph(graph: dict, evidence: dict, source: bytes) -> None:
    """Reconstruct every typed witness and reject altered, missing or extra graph claims.

    Reconstruction resolves captured fields and traverses actual expression constructors
    in their validated contexts. Equality also checks endpoint meaning, full coverage,
    source labels and policy versions. This checker accepts only this projection version.
    """
    expected = project_graph(evidence, source)
    if graph != expected:
        raise GraphError('Graph differs from the witnessed projection of the supplied evidence/source')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        evidence = json.loads(args.evidence.read_text(encoding='utf-8'))
        graph = project_graph(evidence, args.source.read_bytes())
        args.output.write_text(canonical(graph) + '\n', encoding='utf-8')
    except (GraphError, OSError, ValueError) as error:
        print(f'Projection failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
