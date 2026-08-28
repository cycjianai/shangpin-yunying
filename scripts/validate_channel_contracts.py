from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def custom_values(attr: dict) -> list[dict]:
    return [value for value in attr.get('customValue') or [] if isinstance(value, dict)]


def display_values(attr: dict) -> list[str]:
    output: list[str] = []
    for value in custom_values(attr):
        text = str(value.get('attrValue') or '').strip()
        if text:
            output.append(text)
        for struct in value.get('structAttrValueList') or []:
            for row in struct.get('valueList') or []:
                if isinstance(row, list):
                    rendered = ''.join(
                        str(part.get('value') or part.get('optionValue') or '')
                        for part in row if isinstance(part, dict)
                    ).strip()
                    if rendered:
                        output.append(rendered)
    return output


def option_pairs(attr: dict) -> set[tuple[str, str]]:
    return {
        (str(item.get('attrValueId') or ''), str(item.get('attrValue') or '').strip())
        for item in attr.get('attrValueList') or []
        if isinstance(item, dict) and str(item.get('attrValue') or '').strip()
    }


def type9_valid(attr: dict) -> bool:
    values = custom_values(attr)
    if len(values) != 1:
        return False
    value = values[0]
    text = str(value.get('attrValue') or '').strip()
    match = re.fullmatch(r'(\d+(?:\.\d+)?)(.+)', text)
    if not match:
        return False
    unit = match.group(2).strip()
    option = next(
        (item for item in attr.get('optionList') or [] if str(item.get('optionValue') or '') == unit),
        None,
    )
    actual_id = str(value.get('attrValueId') or '')
    expected_id = str(option.get('optionId') or '') if option else ''
    return bool(option and (not actual_id or actual_id == expected_id))


def type10_valid(attr: dict) -> bool:
    values = custom_values(attr)
    if len(values) != 1 or str(values[0].get('attrValue') or '').strip():
        return False
    templates = attr.get('structAttrTemplateList') or []
    expected = (templates[0].get('valueFormatList') or []) if templates else []
    structs = values[0].get('structAttrValueList') or []
    rows = (structs[0].get('valueList') or []) if len(structs) == 1 else []
    combination_limit = int(((templates[0].get('valueFormatTypeList') or [{}])[0]).get('combinationLimit') or 0) if templates else 0
    if not rows or (combination_limit > 0 and len(rows) > combination_limit):
        return False
    expected_sequences = {int(part.get('sequence') or 0) for part in expected}
    for row in rows:
        if not isinstance(row, list):
            return False
        actual = {int(part.get('sequence') or 0): part for part in row if isinstance(part, dict)}
        if expected_sequences != set(actual):
            return False
        for part in expected:
            sequence = int(part.get('sequence') or 0)
            cell = actual[sequence]
            input_type = int(part.get('inputType') or 0)
            if input_type == 5:
                allowed = {
                    (str(item.get('optionId') or ''), str(item.get('optionValue') or ''))
                    for item in part.get('optionList') or []
                }
                if (str(cell.get('optionId') or ''), str(cell.get('optionValue') or '')) not in allowed:
                    return False
            elif input_type == 3:
                if str(cell.get('value') or '') != str(part.get('fixValue') or ''):
                    return False
            elif not str(cell.get('value') or '').strip():
                return False
    return True


def contract_status(attr: dict) -> tuple[bool, str]:
    attr_type = str(attr.get('attrValueType') or '')
    values = custom_values(attr)
    if attr_type == '9':
        return type9_valid(attr), 'type9_number_unit_not_canonical'
    if attr_type == '10':
        return type10_valid(attr), 'type10_structure_not_canonical'
    if not display_values(attr):
        return False, 'blank'
    options = option_pairs(attr)
    if attr_type in {'1', '2', '5'} and options:
        actual = {
            (str(value.get('attrValueId') or ''), str(value.get('attrValue') or '').strip())
            for value in values
        }
        return bool(actual and actual.issubset(options)), 'option_id_label_mismatch'
    if attr_type == '8':
        text = str(values[0].get('attrValue') or '').strip() if values else ''
        valid = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', text) and str(values[0].get('attrValueId') or '') == '0')
        return valid, 'date_not_canonical'
    return True, 'valid'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--details', required=True)
    parser.add_argument('--spu')
    parser.add_argument('--output')
    args = parser.parse_args()
    products = json.loads(Path(args.details).read_text(encoding='utf-8'))['products']
    if args.spu:
        products = [item for item in products if str(item.get('spu_id') or '') == str(args.spu)]
    issues: list[dict] = []
    missing_on_platform = 0
    extant_checked = 0
    for product in products:
        if bool(product.get('missing_on_platform')):
            missing_on_platform += 1
            continue
        extant_checked += 1
        detail = product.get('detail') or {}
        for channel_index, channel in enumerate(detail.get('spuChannelInfoList') or []):
            for attr in channel.get('categoryProperties') or []:
                valid, reason = contract_status(attr)
                if not valid:
                    issues.append({
                        'spu_id': str(product.get('spu_id') or ''),
                        'title': str(product.get('title') or ''),
                        'channel_index': channel_index,
                        'channel_id': int(channel.get('channelId') or 0),
                        'category_code': str(channel.get('categoryCode') or ''),
                        'attr_id': str(attr.get('attrId') or ''),
                        'attr_name': str(attr.get('attrName') or ''),
                        'attr_type': str(attr.get('attrValueType') or ''),
                        'reason': reason,
                        'display_values': display_values(attr),
                    })
    result = {
        'products_checked': len(products),
        'platform_extant_checked': extant_checked,
        'missing_on_platform_count': missing_on_platform,
        'products_with_issues': len({item['spu_id'] for item in issues}),
        'issue_count': len(issues),
        'issues': issues,
    }
    if args.output:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(1 if issues else 0)


if __name__ == '__main__':
    main()
