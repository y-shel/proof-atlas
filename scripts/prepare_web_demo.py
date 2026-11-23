#!/usr/bin/env python3
"""Regenerate the browser demo with the pinned native exporter and projector."""
import json
from pathlib import Path
from export_evidence import export_evidence
from project_graph import project_graph
root = Path(__file__).resolve().parent.parent
source = root / 'experiments/native-extraction/Fixtures.lean'
evidence = export_evidence(source, ['localFact', 'branches', 'termOnly', 'repeated'])
output = root / 'web/public/demo.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(project_graph(evidence, source.read_bytes()), ensure_ascii=False), encoding='utf-8')
print(output)
