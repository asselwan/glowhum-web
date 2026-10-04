#!/usr/bin/env python3
"""Single-sample CLI for the Glowhum evidence scorer's WER algorithm.

Adapted from .ainur/review/glowhum-webbook/tts-measure-evidence/score_asr.py.
"""
import json
import pathlib
import re
import sys


def tokens(value):
    return re.findall(r'[a-z0-9]+', value.lower())


def score(reference, hypothesis):
    a, b = tokens(reference), tokens(hypothesis)
    previous = [(j, 0, j, 0) for j in range(len(b) + 1)]
    for i, word in enumerate(a, 1):
        row = [(i, 0, 0, i)]
        for j, heard in enumerate(b, 1):
            if word == heard:
                row.append(previous[j - 1])
            else:
                deletion = previous[j]
                insertion = row[j - 1]
                substitution = previous[j - 1]
                options = [
                    (deletion[0] + 1, deletion[1], deletion[2], deletion[3] + 1),
                    (insertion[0] + 1, insertion[1], insertion[2] + 1, insertion[3]),
                    (substitution[0] + 1, substitution[1] + 1, substitution[2], substitution[3]),
                ]
                row.append(min(options, key=lambda x: x[0]))
        previous = row
    distance, substitutions, insertions, deletions = previous[-1]
    return {'reference_words': len(a), 'hypothesis_words': len(b), 'substitutions': substitutions, 'insertions': insertions, 'deletions': deletions, 'wer': round(distance / len(a), 4)}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: score_asr.py <reference.txt> <asr.json>')
    reference = pathlib.Path(sys.argv[1]).read_text()
    data = json.loads(pathlib.Path(sys.argv[2]).read_text())
    transcript = ''.join(segment['text'] for segment in data['segments']).strip()
    print(json.dumps(score(reference, transcript)))
