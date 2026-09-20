import json
import tempfile
from pathlib import Path
from watermark_scan import classify, run


def main():
    template={'kind':'template','brand':'brand-a','category':'logo','score':.9,'hit':.8,'calibrated':False}
    assert classify([template],{'complete':True})['status']=='待复核'
    template['calibrated']=True
    assert classify([template],{})['status']=='命中'
    ocr={'kind':'ocr','brand':'brand-b','texts':['包装品牌']}
    assert classify([ocr],{'complete':True})['status']=='待复核'
    assert classify([],{'complete':True})['status']=='未检出'
    assert classify([],{})['status']=='识别未完成'
    assert classify([template],{}, {'status':'未检出','reason':'包装商标非目标'})['brands']==[]
    result=classify([template],{}, {'status':'命中','brands':['brand-b'],'categories':['边框'],'reason':'用户确认'})
    assert result['brands']==['brand-b'] and result['categories']==['边框']
    with tempfile.TemporaryDirectory() as tmp:
        root=Path(tmp);manifest=root/'manifest.json';profile=root/'profile.json'
        profile.write_text('{}')
        for rows in [[{'spu':123}],[{'spu':'exact-id'},{'spu':'exact-id'}]]:
            manifest.write_text(json.dumps(rows))
            try:run(manifest,profile,root/'out')
            except ValueError as e:assert str(e)=='unique_string_spu_required'
            else:raise AssertionError('invalid identities accepted')
    print('watermark scan decision tests passed')


if __name__=='__main__':main()
