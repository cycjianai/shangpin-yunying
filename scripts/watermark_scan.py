"""Offline configurable watermark scan; no platform requests or mutations."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def classify(evidence, ocr, audit=None):
    hits = [e for e in evidence if e['kind'] == 'template' and e['calibrated'] and e['score'] >= e['hit']]
    status = '命中' if hits else '待复核' if evidence else '未检出' if ocr.get('complete') else '识别未完成'
    result = {'status': status, 'brands': sorted({e['brand'] for e in hits}),
              'categories': sorted({e['category'] for e in hits}), 'evidence': evidence}
    if audit is not None:
        if audit.get('status') not in ['命中', '未检出'] or not audit.get('reason'):
            raise ValueError('audit_requires_status_and_reason')
        if audit['status'] == '命中' and (not audit.get('brands') or not audit.get('categories')):
            raise ValueError('positive_audit_requires_brand_and_category')
        result.update(status=audit['status'], brands=audit.get('brands', []) if audit['status']=='命中' else [],
                      categories=audit.get('categories', []) if audit['status']=='命中' else [], auditReason=audit['reason'])
    return result


def load_templates(profile, root):
    import cv2
    import numpy as np
    templates = []
    ids = [b['id'] for b in profile['brands']]
    if len(ids) != len(set(ids)) or not ids:
        raise ValueError('unique_brand_ids_required')
    for brand in profile['brands']:
        for spec in brand.get('templates', []):
            if not 0 <= spec['candidate'] <= spec['hit'] <= 1 or spec['mode'] not in ['gray', 'highpass']:
                raise ValueError('invalid_template_parameters')
            gray = cv2.imread(str(root / spec['path']), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError('reference_decode_failed')
            gray = cv2.resize(gray, (1000,1000), interpolation=cv2.INTER_AREA).astype(np.float32)
            if spec['mode']=='highpass': gray = gray-cv2.GaussianBlur(gray,(0,0),2)
            x1,y1,x2,y2 = spec['crop']
            if not (0 <= x1 < x2 <= 1000 and 0 <= y1 < y2 <= 1000):
                raise ValueError('invalid_crop')
            for scale in spec.get('scales', [1]):
                if scale <= 0: raise ValueError('invalid_scale')
                patch=cv2.resize(gray[y1:y2,x1:x2],None,fx=scale,fy=scale)
                if min(patch.shape)<2 or max(patch.shape)>1000 or patch.std()<.2:
                    raise ValueError('invalid_or_flat_template')
                templates.append((brand['id'],spec,patch))
    return templates


def detect(path, templates):
    import cv2
    import numpy as np
    gray=cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)
    if gray is None: raise ValueError('image_decode_failed')
    gray=cv2.resize(gray,(1000,1000),interpolation=cv2.INTER_AREA).astype(np.float32)
    high=gray-cv2.GaussianBlur(gray,(0,0),2)
    evidence=[]
    for brand,spec,patch in templates:
        source=high if spec['mode']=='highpass' else gray
        scores=cv2.matchTemplate(source,patch,cv2.TM_CCOEFF_NORMED)
        h,w=patch.shape
        # Check several maxima: the global peak may be a numerically flat area.
        for _ in range(3):
            _,score,_,(x,y)=cv2.minMaxLoc(scores)
            if score < spec['candidate']: break
            if source[y:y+h,x:x+w].std() >= .2:
                evidence.append({'kind':'template','brand':brand,'category':spec['category'],
                                 'score':round(score,6),'hit':spec['hit'],
                                 'calibrated':spec.get('calibrated',False),'box':[x,y,w,h]})
                break
            scores[max(0,y-40):y+40,max(0,x-100):x+100]=-1
    return evidence


def run(manifest_path, profile_path, output, audit_path=None):
    products=json.loads(manifest_path.read_text())
    profile=json.loads(profile_path.read_text())
    audit=json.loads(audit_path.read_text()) if audit_path else {}
    ids=[p['spu'] for p in products]
    if any(not isinstance(s,str) or not s for s in ids) or len(set(ids))!=len(ids):
        raise ValueError('unique_string_spu_required')
    templates=load_templates(profile,profile_path.parent)
    cache={};rows=[]
    for p in products:
        row={k:p.get(k,'') for k in ['spu','name','url']}
        if not p.get('path'):
            row['status']='读取失败' if p.get('url') else '主图为空'
        else:
            path=manifest_path.parent/p['path']
            try:
                key=hashlib.sha256(path.read_bytes()).hexdigest();row['sha256']=key
                if key not in cache: cache[key]=detect(path,templates)
                evidence=list(cache[key]);ocr=p.get('ocr',{})
                for brand in profile['brands']:
                    matches=[t for t in ocr.get('texts',[]) if any(term and term in t for term in brand.get('terms',[]))]
                    if matches: evidence.append({'kind':'ocr','brand':brand['id'],'texts':matches})
                row.update(classify(evidence,ocr,audit.get(key)))
            except (OSError,ValueError) as e:
                row.update(status='读取失败',error=str(e))
        rows.append(row)
    output.mkdir(parents=True,exist_ok=True)
    (output/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
    summary={'totalSpu':len(rows),'uniqueImages':len(cache),'counts':dict(Counter(r['status'] for r in rows)),
             'platformWrites':0,'paidCalls':0}
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    for status,name in [('命中','matched-spu.txt'),('待复核','pending-spu.txt')]:
        values=[r['spu'] for r in rows if r['status']==status]
        (output/name).write_text(''.join(s+'\n' for s in values))
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['manifest','profile','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--audit',type=Path)
    args=parser.parse_args()
    print(json.dumps(run(args.manifest,args.profile,args.output,args.audit),ensure_ascii=False))
