"""Translations (translations/*.json): every language has the same keys, and every key the code uses exists."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / 'translations'
CODE = [ROOT / 'app.js', ROOT / 'config.html', ROOT / 'index.html', *sorted((ROOT / 'lib').glob('*.js'))]
KEY = re.compile(r'''['"`]((?:panel|web)\.[a-z0-9_]+\.[a-z0-9_]+)['"`]''')


def _flat(obj, prefix=''):
    out = {}
    for k, v in obj.items():
        if isinstance(v, dict):
            out.update(_flat(v, prefix + k + '.'))
        else:
            assert isinstance(v, str), prefix + k
            out[prefix + k] = v
    return out


def _lang(code):
    return json.loads((DIR / f'{code}.json').read_text(encoding='utf-8'))


def test_languages_are_valid():
    langs = json.loads((DIR / 'languages.json').read_text(encoding='utf-8'))
    assert 'es' in langs and 'en' in langs
    for code in langs:
        data = _lang(code)
        assert data['name'] == langs[code] and data['locale']
        _flat(data['texts'])
        pats = data.get('patterns', [])
        for p in (pats if isinstance(pats, list) else [x for v in pats.values() for x in v]):
            assert 2 <= len(p) <= 3 and all(isinstance(x, str) for x in p), p


def test_every_language_has_every_key():
    es = set(_flat(_lang('es')['texts']))
    langs = json.loads((DIR / 'languages.json').read_text(encoding='utf-8'))
    for code in langs:
        keys = set(_flat(_lang(code)['texts']))
        assert not es - keys, f'{code}.json lacks: {sorted(es - keys)[:20]}'
        assert not keys - es, f'{code}.json has keys that es.json does not: {sorted(keys - es)[:20]}'


def test_every_key_in_the_code_exists():
    es = _flat(_lang('es')['texts'])
    used = set()
    for f in CODE:
        used |= set(KEY.findall(f.read_text(encoding='utf-8')))
        used |= set(re.findall(r'data-i18n="([^"]+)"', f.read_text(encoding='utf-8')))
    assert len(used) > 400
    missing = sorted(k for k in used if k not in es)
    assert not missing, f'keys used in the code but not in es.json: {missing}'


def test_variables_match():
    es, en = _flat(_lang('es')['texts']), _flat(_lang('en')['texts'])
    for k, v in es.items():
        assert set(re.findall(r'\{(\w+)\}', v)) == set(re.findall(r'\{(\w+)\}', en[k])), k
