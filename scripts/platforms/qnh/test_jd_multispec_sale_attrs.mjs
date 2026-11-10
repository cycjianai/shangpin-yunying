import assert from 'node:assert/strict';
import { fillJdMultiSpecSaleAttrs } from './required_property_rules.mjs';

const sampleDetail = {
  spuId: '2112428688972595248',
  spuName: '【舒服不塌陷】家用宿舍用床垫 1床',
  specType: 2,
  spuChannelInfoList: [
    {
      channelId: 300,
      categoryCode: '27770',
      categoryName: '其他床品套件',
      saleAttrList: [],
      skuPicSetting: null,
    },
  ],
  skus: [
    {
      skuId: '1',
      specName: '90*200cm（约3.5cm宿舍专用）',
      skuChannelInfoList: null,
    },
    {
      skuId: '2',
      specName: '120*200cm（约3.5cm）',
      skuChannelInfoList: [{ channelId: 300, saleAttrValueList: null }],
    },
    {
      skuId: '3',
      specName: '150*200cm（约3.5cm）',
      skuChannelInfoList: [],
    },
    {
      skuId: '4',
      specName: '180*200cm（约3.5cm）',
      skuChannelInfoList: [],
    },
  ],
};

const res = fillJdMultiSpecSaleAttrs(sampleDetail, [
  { attrId: '1577293', attrName: '颜色' },
  { attrId: '1577303', attrName: '尺码' },
]);

assert.equal(res.changed, true);
assert.equal(res.attrId, '1577293');
assert.equal(res.attrName, '颜色');
assert.equal(sampleDetail.spuChannelInfoList[0].saleAttrList.length, 1);
assert.equal(sampleDetail.spuChannelInfoList[0].saleAttrList[0].attrId, '1577293');
assert.equal(sampleDetail.spuChannelInfoList[0].skuPicSetting, 0);

for (const sku of sampleDetail.skus) {
  const sci300 = sku.skuChannelInfoList.find(s => Number(s.channelId) === 300);
  assert.ok(sci300, 'Every SKU must have channelId=300 in skuChannelInfoList');
  assert.equal(sci300.saleAttrValueList.length, 1);
  assert.equal(sci300.saleAttrValueList[0].attrId, 1577293);
  assert.equal(sci300.saleAttrValueList[0].attrName, '颜色');
  assert.equal(sci300.saleAttrValueList[0].attrValue, sku.specName);
}

// Second pass should be idempotent (changed === false)
const res2 = fillJdMultiSpecSaleAttrs(sampleDetail, [
  { attrId: '1577293', attrName: '颜色' },
]);
assert.equal(res2.changed, false);
