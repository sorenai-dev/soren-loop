#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["cryptography==46.0.3"]
# ///
"""Independent oracle for test-vectors/challenge.json and receipt.json (RFC 04 section 3.5,
RFC 17 section 1).

It shares no code with packages/schema. Challenge preimages are framed here by hand, target
lists are hand-written JCS literals, and receipts are signed with fixed test-only P-256 keys
using deterministic ECDSA (RFC 6979), so regenerating gives identical files:

    uv run packages/schema/test-vectors/tools/challenge_oracle.py packages/schema/test-vectors

The PEP 723 header pins `cryptography`. Output is ASCII-only JSON.
"""
import base64
import hashlib
import json
import struct
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

N_P256 = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def lp(s: str) -> bytes:
    b = s.encode('utf-8')
    return struct.pack('>I', len(b)) + b


def frame(prefix: str, *fields: str) -> bytes:
    return lp(prefix) + b''.join(lp(f) for f in fields)


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode('ascii')


def sha(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def fixed_hex(label: str, nbytes: int) -> str:
    return sha(label.encode('ascii'))[:nbytes].hex()


# ---- Challenge vectors (Task 014) ---------------------------------------------------------
W = 'sl:webauthn:v1'
CH1 = fixed_hex('content-1', 32)
CH2 = fixed_hex('content-2', 32)
NONCE1 = fixed_hex('nonce-1', 16)
NONCE2 = fixed_hex('nonce-2', 16)
EMOJI = '\U0001F600'
FI = '\ufb01'

CHALLENGES = []


def challenge(vid, description, input_, targets_jcs):
    pre = frame(W, input_['action'], targets_jcs, input_['contentHash'], input_['nonce'])
    digest = sha(pre)
    CHALLENGES.append({
        'id': vid, 'fn': 'deriveChallenge', 'description': description, 'input': input_,
        'expected_bytes_hex': pre.hex(), 'expected_hash': digest.hex(),
        'expected_webauthn_challenge': b64url(digest),
    })
    return digest.hex()


REQ_T = [{'type': 'request', 'id': 'req_1'}]
REQ_T_JCS = '[{"id":"req_1","type":"request"}]'
C01 = {'action': 'request.approve', 'targets': REQ_T, 'contentHash': CH1, 'nonce': NONCE1}
c01 = challenge('C-01', 'request.approve over one request target', C01, REQ_T_JCS)

BULK_JCS = ('[{"id":"req_1","type":"request"},{"id":"req_2","type":"request"},'
            '{"id":"req_3","type":"request"}]')
BULK = [{'type': 'request', 'id': i} for i in ['req_3', 'req_1', 'req_2']]
challenge('C-02a', 'requests.bulk_reject over three request targets given out of order',
          {'action': 'requests.bulk_reject', 'targets': BULK, 'contentHash': CH1, 'nonce': NONCE1}, BULK_JCS)
challenge('C-02b', 'The C-02a targets in another order: the same challenge',
          {'action': 'requests.bulk_reject', 'targets': list(reversed(BULK)), 'contentHash': CH1,
           'nonce': NONCE1}, BULK_JCS)
challenge('C-02c', 'Bulk reject of req_1 and req_2 only: a different challenge from C-02a (ST-50)',
          {'action': 'requests.bulk_reject', 'targets': BULK[1:], 'contentHash': CH1, 'nonce': NONCE1},
          '[{"id":"req_1","type":"request"},{"id":"req_2","type":"request"}]')
challenge('C-03', 'site_config.update over one site target',
          {'action': 'site_config.update', 'targets': [{'type': 'site', 'id': 'site_1'}],
           'contentHash': CH1, 'nonce': NONCE1}, '[{"id":"site_1","type":"site"}]')
challenge('C-04', 'Bulk reject ids sort by UTF-8 bytes: U+FB01 before U+1F600, the reverse of '
          'UTF-16 order',
          {'action': 'requests.bulk_reject', 'contentHash': CH1, 'nonce': NONCE1,
           'targets': [{'type': 'request', 'id': EMOJI}, {'type': 'request', 'id': FI}]},
          '[{"id":"' + FI + '","type":"request"},{"id":"' + EMOJI + '","type":"request"}]')
challenge('C-06', 'hold.clear targets sort by type first: request req_1, then verdict pv_1, '
          'although pv_1 sorts before req_1 by id',
          {'action': 'hold.clear', 'contentHash': CH1, 'nonce': NONCE1,
           'targets': [{'type': 'verdict', 'id': 'pv_1'}, {'type': 'request', 'id': 'req_1'}]},
          '[{"id":"req_1","type":"request"},{"id":"pv_1","type":"verdict"}]')
challenge('C-05a', 'C-01 with only the action changed', dict(C01, action='spec.approve'), REQ_T_JCS)
challenge('C-05b', 'C-01 with only the nonce changed', dict(C01, nonce=NONCE2), REQ_T_JCS)
challenge('C-05c', 'C-01 with only the content hash changed', dict(C01, contentHash=CH2), REQ_T_JCS)

# ---- Receipt vectors (Task 015) -----------------------------------------------------------
ORIGIN, RP_ID = 'https://loop.example.test', 'loop.example.test'


def make_key(label):
    d = int(sha(('soren-loop virtual authenticator ' + label).encode('ascii')).hex(), 16) % N_P256
    priv = ec.derive_private_key(d, ec.SECP256R1())
    nums = priv.public_key().public_numbers()
    x, y = nums.x.to_bytes(32, 'big'), nums.y.to_bytes(32, 'big')
    # COSE_Key map {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, encoded by hand.
    cose = bytes.fromhex('a50102032620012158') + bytes([0x20]) + x + bytes.fromhex('225820') + y
    cred = sha(('credential ' + label).encode('ascii'))[:16]
    return {'priv': priv, 'd': format(d, '064x'), 'x': x.hex(), 'y': y.hex(),
            'pinned': {'credentialId': b64url(cred), 'publicKeyCose': b64url(cose)}}


KEY_A, KEY_B = make_key('A'), make_key('B')
OWNER = 'owner_1'
PIN = {'ownerId': OWNER, 'keys': [KEY_A['pinned']], 'origin': ORIGIN, 'rpId': RP_ID}


def assertion(key, challenge_hex, origin=ORIGIN, rp_id=RP_ID, flags=0x05, type_='webauthn.get',
              nonce=NONCE1, cross_origin='false', other_s=False):
    client = ('{"type":"' + type_ + '","challenge":"' + b64url(bytes.fromhex(challenge_hex))
              + '","origin":"' + origin + '","crossOrigin":' + cross_origin + '}').encode('utf-8')
    auth = sha(rp_id.encode('utf-8')) + bytes([flags]) + struct.pack('>I', 1)
    sig = key['priv'].sign(auth + sha(client), ec.ECDSA(hashes.SHA256(), deterministic_signing=True))
    if other_s:
        r, s = decode_dss_signature(sig)
        s = N_P256 - s  # the other valid signature for the same r: low-S and high-S both verify
        sig = encode_dss_signature(r, s)
    return {'credentialId': key['pinned']['credentialId'], 'nonce': nonce,
            'authenticatorData': b64url(auth), 'clientDataJSON': b64url(client), 'signature': b64url(sig)}


RECEIPTS = []


def receipt(vid, description, receipt_, expected, action='request.approve', targets=REQ_T,
            content_hash=CH1, pin=PIN):
    RECEIPTS.append({'id': vid, 'fn': 'verifyReceipt', 'description': description,
                     'input': {'receipt': receipt_, 'expectedContentHash': content_hash,
                               'action': action, 'targets': targets, 'pin': pin},
                     'expected_result': expected})


OK = {'ok': True}


def fail(reason):
    return {'ok': False, 'reason': reason}


R01 = assertion(KEY_A, c01)
receipt('R-01', 'A valid receipt from pinned key A verifies offline', R01, OK)
receipt('R-01h', 'R-01 re-signed with s replaced by n - s (the other of low-S/high-S) also verifies', assertion(KEY_A, c01, other_s=True), OK)
receipt('R-02', 'Wrong origin (ST-63)', assertion(KEY_A, c01, origin='https://evil.example.test'),
        fail('wrong_origin'))
receipt('R-02x', 'crossOrigin true (ST-63)', assertion(KEY_A, c01, cross_origin='true'), fail('wrong_origin'))
receipt('R-02p', 'An origin that only starts with the pinned origin (ST-63)',
        assertion(KEY_A, c01, origin='https://loop.example.test.evil.example'), fail('wrong_origin'))
receipt('R-10', 'Two defects (wrong origin and UV clear): the first failing step, origin, wins',
        assertion(KEY_A, c01, origin='https://evil.example.test', flags=0x01), fail('wrong_origin'))
receipt('R-03', 'rpIdHash of another RP ID (ST-63)', assertion(KEY_A, c01, rp_id='evil.example.test'),
        fail('wrong_rp_id_hash'))
receipt('R-04', 'UV flag clear, UP set (ST-63)', assertion(KEY_A, c01, flags=0x01), fail('uv_not_set'))
receipt('R-05', 'Signed by key B, which is not pinned (ST-63)', assertion(KEY_B, c01), fail('unpinned_key'))
receipt('R-07a', 'R-01 checked against a different content hash (ST-63)', R01, fail('challenge_mismatch'),
        content_hash=CH2)
receipt('R-07b', 'R-01 checked against a different target (ST-50, ST-63)', R01, fail('challenge_mismatch'),
        targets=[{'type': 'request', 'id': 'req_2'}])
receipt('R-07c', 'R-01 checked as a different action (ST-50, ST-63)', R01, fail('challenge_mismatch'),
        action='spec.approve')
sig = bytearray(base64.urlsafe_b64decode(R01['signature'] + '=='))
sig[10] ^= 0x01  # inside r, so the DER structure stays valid
receipt('R-08', 'One byte of the signature flipped (ST-63)', dict(R01, signature=b64url(bytes(sig))),
        fail('bad_signature'))
receipt('R-09', 'clientDataJSON type webauthn.create', assertion(KEY_A, c01, type_='webauthn.create'),
        fail('wrong_type'))

# R-06: pin-set growth. The add receipt binds sl:authenticator:v1 and the pinned owner target.
add_hash = sha(frame('sl:authenticator:v1', OWNER, 'add', KEY_B['pinned']['credentialId'],
                     KEY_B['pinned']['publicKeyCose'])).hex()
OWNER_T_JCS = '[{"id":"' + OWNER + '","type":"owner"}]'
add_challenge = sha(frame(W, 'authenticator.add', OWNER_T_JCS, add_hash, NONCE2)).hex()


def grow(vid, description, receipt_, expected):
    add = {'key': KEY_B['pinned']}
    if receipt_ is not None:
        add['receipt'] = receipt_
    RECEIPTS.append({'id': vid, 'fn': 'growPinSet', 'description': description,
                     'input': {'pin': PIN, 'add': add}, 'expected_result': expected,
                     'expected_add_hash': add_hash})


grow('R-06a', 'Key B added with an add receipt signed by B itself (ST-63)',
     assertion(KEY_B, add_challenge, nonce=NONCE2), dict(fail('key_added_without_receipt'), cause='unpinned_key'))
grow('R-06b', 'Key B added with no receipt (ST-63)', None, fail('key_added_without_receipt'))
grow('R-06c', 'Key B added with an add receipt signed by pinned key A',
     assertion(KEY_A, add_challenge, nonce=NONCE2),
     {'ok': True, 'pin': dict(PIN, keys=[KEY_A['pinned'], KEY_B['pinned']])})
receipt('R-06d', 'After R-06c, a receipt signed by B verifies against the grown pin set',
        assertion(KEY_B, c01), OK,
        pin=dict(PIN, keys=[KEY_A['pinned'], KEY_B['pinned']]))

KEYS_NOTE = {kid: {'d': k['d'], 'x': k['x'], 'y': k['y'], **k['pinned']}
             for kid, k in (('A', KEY_A), ('B', KEY_B))}

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    with open(f'{out}/challenge.json', 'w', encoding='ascii') as f:
        f.write(json.dumps(CHALLENGES, indent=2, ensure_ascii=True) + '\n')
    with open(f'{out}/receipt.json', 'w', encoding='ascii') as f:
        f.write(json.dumps(RECEIPTS, indent=2, ensure_ascii=True) + '\n')
    print(json.dumps(KEYS_NOTE, indent=2))
