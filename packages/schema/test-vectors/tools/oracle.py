#!/usr/bin/env python3
"""Independent oracle for test-vectors/hash.json (RFC 04 section 3).

It shares no code with packages/schema. Every preimage is assembled here by hand from the
prefix registry's field lists, and every JCS string is a hand-written literal rather than the
output of a serializer. Run it to regenerate the file:

    python3 packages/schema/test-vectors/tools/oracle.py > packages/schema/test-vectors/hash.json

The output is ASCII-only JSON (non-ASCII characters are escaped).
"""
import base64
import hashlib
import json
import struct


def lp(s: str) -> bytes:
    b = s.encode('utf-8')
    return struct.pack('>I', len(b)) + b


def frame(prefix: str, *fields: str) -> bytes:
    return lp(prefix) + b''.join(lp(f) for f in fields)


VECTORS = []


def add(vid, description, input_, prefix, fields, **extra):
    pre = frame(prefix, *fields)
    VECTORS.append({
        'id': vid,
        'description': description,
        'input': input_,
        **extra,
        'expected_bytes_hex': pre.hex(),
        'expected_hash': hashlib.sha256(pre).hexdigest(),
    })
    return hashlib.sha256(pre).hexdigest()


def note(vid, description, input_, **extra):
    VECTORS.append({'id': vid, 'description': description, 'input': input_, **extra})


EMOJI = '\U0001F600'
T = 'sl:test:v1'

# ---- Task 011: framing -------------------------------------------------------------------
add('H-13a', 'LP framing: fields ("ab", "c")', {'prefix': T, 'fields': ['ab', 'c']}, T, ['ab', 'c'])
add('H-13b', 'LP framing: fields ("a", "bc") hash differently from H-13a',
    {'prefix': T, 'fields': ['a', 'bc']}, T, ['a', 'bc'])
add('H-13c', 'Zero fields: the preimage is LP(prefix) alone', {'prefix': T, 'fields': []}, T, [])
add('H-14', 'An astral-plane string among BMP strings sorts by UTF-8 bytes (code point order), '
    'not UTF-16 order; the sorted list is hashed as fields under a test prefix',
    {'prefix': T, 'unsorted': ['ﬁ', EMOJI, 'a', '']}, T, ['a', '', 'ﬁ', EMOJI],
    expected_sorted=['a', '', 'ﬁ', EMOJI])
note('H-15', 'P(path): ./src/a.ts, src/a.ts and src//a.ts give one result; ../x is rejected',
     {'same': ['./src/a.ts', 'src/a.ts', 'src//a.ts'], 'rejected': '../x'},
     expected_normalized='src/a.ts', expected_error='path_traversal')
note('P-01', 'P drops a "." segment in the middle', {'path': 'src/./a.ts'}, expected_normalized='src/a.ts')
note('P-02', 'P drops a trailing slash', {'path': 'src/'}, expected_normalized='src')
note('P-03', 'A colon is legal in a relative POSIX path', {'path': 'a:b.md'}, expected_normalized='a:b.md')
note('JCS-01', 'RFC 8785 sorts object keys by UTF-16 code units: U+1F600 (D83D DE00) before U+FB01',
     {'value': {'ﬁ': 1, EMOJI: 2}},
     expected_bytes_hex=('{"' + EMOJI + '":2,"ﬁ":1}').encode('utf-8').hex())

# ---- Task 013: content hashes ------------------------------------------------------------
SITE, REQ = 'site_1', 'req_1'
F1 = {'title': 'Export CSV', 'problem': 'I need my data.',
      'acceptance_criteria': ['A button exports CSV'], 'area': None, 'owner_context': None}
F1_JCS = ('{"acceptance_criteria":["A button exports CSV"],"area":null,"owner_context":null,'
          '"problem":"I need my data.","title":"Export CSV"}')
F2 = dict(F1, area='billing')
F2_JCS = ('{"acceptance_criteria":["A button exports CSV"],"area":"billing","owner_context":null,'
          '"problem":"I need my data.","title":"Export CSV"}')
REQ1 = {'siteId': SITE, 'requestId': REQ, 'rev': 1, 'kind': 'requester', 'parentHReq': None}

h01 = add('H-01', 'Rev 1 request with area null', dict(REQ1, fields=F1),
          'sl:req:v1', [SITE, REQ, '1', 'requester', '', F1_JCS])
add('H-02', 'The H-01 request with area set gives a different hash', dict(REQ1, fields=F2),
    'sl:req:v1', [SITE, REQ, '1', 'requester', '', F2_JCS])
F1_REORDERED = {k: F1[k] for k in ['owner_context', 'area', 'title', 'acceptance_criteria', 'problem']}
add('H-03', 'H-01 with input keys in a different order: identical H_req (JCS)',
    dict(REQ1, fields=F1_REORDERED), 'sl:req:v1', [SITE, REQ, '1', 'requester', '', F1_JCS])
F4 = dict(F1, owner_context='Use the existing export service.')
F4_JCS = ('{"acceptance_criteria":["A button exports CSV"],"area":null,'
          '"owner_context":"Use the existing export service.","problem":"I need my data.",'
          '"title":"Export CSV"}')
add('H-04', 'Rev 2 owner_context revision whose parent_h_req is H-01',
    {'siteId': SITE, 'requestId': REQ, 'rev': 2, 'kind': 'owner_context', 'parentHReq': h01, 'fields': F4},
    'sl:req:v1', [SITE, REQ, '2', 'owner_context', h01, F4_JCS])
note('H-05', 'A missing key is a schema error and is never hashed',
     dict(REQ1, fields={k: v for k, v in F1.items() if k != 'owner_context'}), expected_error='missing_key')
add('H-06a', 'G1 hash of H-01 for class "small"', {'hReq': h01, 'eligibilityClass': 'small'},
    'sl:g1:v1', [h01, 'small'])
add('H-06b', 'G1 hash of H-01 for class "standard" differs from H-06a',
    {'hReq': h01, 'eligibilityClass': 'standard'}, 'sl:g1:v1', [h01, 'standard'])

FB_BODY = 'Use a stream.'
h_fb = add('H-12c', 'Plan feedback hash', {'requestId': REQ, 'kind': 'plan', 'body': FB_BODY},
           'sl:fb:v1', [REQ, 'plan', FB_BODY])
add('H-12cn', 'A feedback body that is not normalized hashes as its N_hash form (CRLF and trailing space removed): same preimage as H-12c',
    {'requestId': REQ, 'kind': 'plan', 'body': 'Use a stream. \r\n'}, 'sl:fb:v1', [REQ, 'plan', FB_BODY])
ENV = '{"body_md":"Add an export button.","paths":["src/a.ts","src/b.ts"]}'
SPEC = {'hReq': h01, 'bodyMd': 'Add an export button.'}
h07 = add('H-07', 'Spec paths unsorted and duplicated (after P) give the sorted-unique H_spec; no h_fb',
          dict(SPEC, hFb=None, paths=['src/b.ts', './src/a.ts', 'src//a.ts']),
          'sl:spec:v1', [h01, '', ENV], equivalent_paths=['src/a.ts', 'src/b.ts'])
add('H-07n', 'A spec body that is not normalized hashes as its N_hash form (trailing U+00A0 stripped): same preimage as H-07',
    dict(SPEC, bodyMd='Add an export button.\u00a0', hFb=None, paths=['src/a.ts', 'src/b.ts']),
    'sl:spec:v1', [h01, '', ENV])
ENV_ASTRAL = '{"body_md":"Add an export button.","paths":["\ufb01.md","' + EMOJI + '.md"]}'
add('H-07a', 'Spec paths sort by UTF-8 bytes: U+FB01 before U+1F600 (UTF-16 order would reverse them)',
    dict(SPEC, hFb=None, paths=[EMOJI + '.md', '\ufb01.md']), 'sl:spec:v1', [h01, '', ENV_ASTRAL])
add('H-08', 'The H-07 spec with h_fb set', dict(SPEC, hFb=h_fb, paths=['src/a.ts', 'src/b.ts']),
    'sl:spec:v1', [h01, h_fb, ENV])
add('H-09', 'Rework hash over H-07 and H-12c', {'hSpec': h07, 'hFb': h_fb}, 'sl:rework:v1', [h07, h_fb])

TRUSTED, BASE = '1' * 40, '2' * 40
L2_ENTRIES = [
    {'path': 'CLAUDE.md', 'status': 'modified', 'blobSha': '3' * 40},
    {'path': './.claude/settings.json', 'status': 'added', 'blobSha': '4' * 40},
]
L2_JCS = ('[{"blob_sha":"' + '4' * 40 + '","path":".claude/settings.json","status":"added"},'
          '{"blob_sha":"' + '3' * 40 + '","path":"CLAUDE.md","status":"modified"}]')
l2 = add('H-10d', 'L2 fingerprint: entries given out of path order, paths through P',
         {'trustedSha': TRUSTED, 'baseSha': BASE, 'entries': L2_ENTRIES}, 'sl:l2:v1', [TRUSTED, BASE, L2_JCS])
L2_ASTRAL_JCS = ('[{"blob_sha":"' + '5' * 40 + '","path":"\ufb01.md","status":"added"},'
                 '{"blob_sha":"' + '6' * 40 + '","path":"' + EMOJI + '.md","status":"added"}]')
add('H-10e', 'L2 entries sort by UTF-8 bytes of the path: U+FB01 before U+1F600',
    {'trustedSha': TRUSTED, 'baseSha': BASE, 'entries': [
        {'path': EMOJI + '.md', 'status': 'added', 'blobSha': '6' * 40},
        {'path': '\ufb01.md', 'status': 'added', 'blobSha': '5' * 40}]},
    'sl:l2:v1', [TRUSTED, BASE, L2_ASTRAL_JCS])
add('H-10c', 'L2 fingerprint with no instruction-file changes (empty list)',
    {'trustedSha': TRUSTED, 'baseSha': BASE, 'entries': []}, 'sl:l2:v1', [TRUSTED, BASE, '[]'])
add('H-10a', 'Hold clear without L2', {'requestId': REQ, 'verdictId': 'ver_1', 'contentHash': h07, 'l2Fingerprint': None},
    'sl:hold_clear:v1', [REQ, 'ver_1', h07, ''])
add('H-10b', 'Hold clear with the H-10d L2 fingerprint',
    {'requestId': REQ, 'verdictId': 'ver_1', 'contentHash': h07, 'l2Fingerprint': l2},
    'sl:hold_clear:v1', [REQ, 'ver_1', h07, l2])

add('H-11a', 'Rollout targets: order and duplicates are irrelevant',
    {'requestId': REQ, 'mode': 'targets', 'targets': ['u2', 'u1', 'u2'], 'docVersion': 7},
    'sl:rollout:v1', [REQ, 'targets', '["u1","u2"]', '7'], equivalent_targets=['u1', 'u2'])
add('H-11b', 'Rollout by basis points', {'requestId': REQ, 'mode': 'bp', 'bp': 2500, 'docVersion': 7},
    'sl:rollout:v1', [REQ, 'bp', '2500', '7'])
add('H-11c', 'Rollout to all', {'requestId': REQ, 'mode': 'all', 'docVersion': 7},
    'sl:rollout:v1', [REQ, 'all', 'all', '7'])
add('H-11d', 'Rollout to all at doc_version 8 differs from H-11c', {'requestId': REQ, 'mode': 'all', 'docVersion': 8},
    'sl:rollout:v1', [REQ, 'all', 'all', '8'])
add('H-14b', 'Rollout targets: an astral-plane sub among BMP subs sorts by UTF-8 bytes',
    {'requestId': REQ, 'mode': 'targets', 'targets': ['ﬁ', EMOJI, 'a'], 'docVersion': 1},
    'sl:rollout:v1', [REQ, 'targets', '["a","ﬁ","' + EMOJI + '"]', '1'])

OVERRIDE = {'quiet_hours': {'start': '22:00', 'end': '07:00'}, 'channels': ['email']}
OVERRIDE_JCS = '{"channels":["email"],"quiet_hours":{"end":"07:00","start":"22:00"}}'
add('H-12a', 'Notification policy override with base_version 3',
    {'siteId': SITE, 'baseVersion': 3, 'override': OVERRIDE},
    'sl:notification_policy:v1', [SITE, '3', OVERRIDE_JCS])
add('H-12e', 'The H-12a override with base_version 4 differs',
    {'siteId': SITE, 'baseVersion': 4, 'override': OVERRIDE},
    'sl:notification_policy:v1', [SITE, '4', OVERRIDE_JCS])
add('H-12b', 'Site config change', {'siteId': SITE, 'setting': 'contact', 'baseVersion': 2,
                                    'value': {'email': 'owner@example.com'}},
    'sl:site_config:v1', [SITE, 'contact', '2', '{"email":"owner@example.com"}'])
add('H-12d', 'Enablement confirmation', {'requestId': REQ, 'deploymentId': 'dep_1', 'flagKey': 'sl_abc'},
    'sl:enable_confirm:v1', [REQ, 'dep_1', 'sl_abc'])

# ---- Task 014: step-up content hashes ----------------------------------------------------
CRED = base64.urlsafe_b64encode(b'credential-1').rstrip(b'=').decode('ascii')
COSE = base64.urlsafe_b64encode(b'cose-key-1').rstrip(b'=').decode('ascii')
AUTH = {'ownerId': 'owner_1', 'credentialId': CRED, 'publicKeyCose': COSE}
add('H-16a', 'Authenticator add', dict(AUTH, op='add'), 'sl:authenticator:v1', ['owner_1', 'add', CRED, COSE])
add('H-16b', 'Authenticator remove of the H-16a key differs', dict(AUTH, op='remove'),
    'sl:authenticator:v1', ['owner_1', 'remove', CRED, COSE])
add('H-17a', 'Bulk reject request ids, unsorted input', {'siteId': SITE, 'requestIds': ['req_3', 'req_1', 'req_2']},
    'sl:bulk_reject:v1', [SITE, '["req_1","req_2","req_3"]'])
add('H-17b', 'The H-17a ids in another order: the same hash', {'siteId': SITE, 'requestIds': ['req_2', 'req_3', 'req_1']},
    'sl:bulk_reject:v1', [SITE, '["req_1","req_2","req_3"]'])

add('H-16c', 'Authenticator add whose credential id uses the - and _ characters (bytes fb ff)',
    dict(AUTH, op='add', credentialId='-_8'), 'sl:authenticator:v1', ['owner_1', 'add', '-_8', COSE])
add('H-17c', 'Bulk reject ids sort by UTF-8 bytes: req_U+FB01 before req_U+1F600 (UTF-16 order is the reverse)',
    {'siteId': SITE, 'requestIds': ['req_\U0001F600', 'req_\ufb01']},
    'sl:bulk_reject:v1', [SITE, '["req_\ufb01","req_\U0001F600"]'])
print(json.dumps(VECTORS, indent=2, ensure_ascii=True))
