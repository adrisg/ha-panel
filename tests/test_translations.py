"""The translation files (translations/*.json) are valid and every listed language has its file."""
import json
from pathlib import Path

DIR = Path(__file__).resolve().parents[1] / 'translations'


def _flat(obj, out):
    for k, v in obj.items():
        if isinstance(v, dict):
            _flat(v, out)
        else:
            assert isinstance(v, str), k
            out[k] = v
    return out


def test_every_language_is_valid():
    langs = json.loads((DIR / 'languages.json').read_text(encoding='utf-8'))
    assert 'es' in langs and 'en' in langs
    for code in langs:
        data = json.loads((DIR / f'{code}.json').read_text(encoding='utf-8'))
        assert data['name'] == langs[code] and data['locale']
        _flat(data.get('texts', {}), {})
        pats = data.get('patterns', [])
        for p in (pats if isinstance(pats, list) else [x for v in pats.values() for x in v]):
            assert 2 <= len(p) <= 3 and all(isinstance(x, str) for x in p), p


def test_english_has_the_texts():
    texts = _flat(json.loads((DIR / 'en.json').read_text(encoding='utf-8'))['texts'], {})
    assert len(texts) > 400
    assert texts['Encendido'] == 'On' and texts['Guardar'] == 'Save'
