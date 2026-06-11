import json
import math
import ssl
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out_dir = ROOT / '用户数据' / 'task_output' / 'data_country_density_2273'
artifact_dir = ROOT / 'artifacts' / 'data-country-density-2273'
out_dir.mkdir(parents=True, exist_ok=True)
artifact_dir.mkdir(parents=True, exist_ok=True)

url = 'https://restcountries.com/v3.1/all?fields=name,population,area,region,cca2'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
ctx = ssl.create_default_context()
with urllib.request.urlopen(req, context=ctx, timeout=25) as resp:
    raw = resp.read().decode('utf-8')
    status = resp.status

countries = json.loads(raw)
records = []
for item in countries:
    name = item.get('name', {}).get('common')
    population = item.get('population')
    area = item.get('area')
    region = item.get('region')
    cca2 = item.get('cca2')
    if not name or not population or not area or area <= 0:
        continue
    density = population / area
    records.append({
        'name': name,
        'cca2': cca2,
        'region': region,
        'population': population,
        'area': area,
        'density': round(density, 2),
    })

records.sort(key=lambda x: x['density'], reverse=True)
top10 = records[:10]
regions = {}
for row in records:
    regions.setdefault(row['region'], []).append(row['density'])
region_avg = {k: round(sum(v)/len(v), 2) for k, v in regions.items() if v}
region_avg_sorted = sorted(region_avg.items(), key=lambda kv: kv[1], reverse=True)

result = {
    'sourceUrl': url,
    'httpStatus': status,
    'countryCount': len(records),
    'top10Density': top10,
    'highestAverageRegion': {'region': region_avg_sorted[0][0], 'avgDensity': region_avg_sorted[0][1]},
    'lowestAverageRegion': {'region': region_avg_sorted[-1][0], 'avgDensity': region_avg_sorted[-1][1]},
}

(artifact_dir / 'country-density.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
md = []
md.append('# 第2273次呼吸-data·5 国家人口密度最小作品')
md.append('')
md.append('## 问题定义')
md.append('- 用公开国家数据快速回答：哪些国家人口密度最高、哪个大区平均最拥挤。')
md.append('')
md.append('## 数据获取/造样')
md.append(f'- 数据源：`{url}`')
md.append(f'- 抓取结果：HTTP `{status}`，有效国家记录 `{len(records)}` 条。')
md.append('')
md.append('## 方法')
md.append('- 对每条记录按 `population / area` 计算人口密度。')
md.append('- 按密度降序取前10名；再按 `region` 聚合计算平均密度。')
md.append('')
md.append('## 结果')
for i, row in enumerate(top10[:5], start=1):
    md.append(f'- TOP{i}：`{row["name"]}`（{row["cca2"]}），密度 `{row["density"]}` 人/平方公里。')
md.append(f'- 平均最拥挤大区：`{region_avg_sorted[0][0]}`，均值 `{region_avg_sorted[0][1]}`。')
md.append(f'- 平均最稀疏大区：`{region_avg_sorted[-1][0]}`，均值 `{region_avg_sorted[-1][1]}`。')
md.append('')
md.append('## 局限')
md.append('- 该接口是国家级静态快照，不含城市级人口分布。')
md.append('- 部分微型地区会因面积极小而把密度推得非常高，不等于城市生活拥挤度。')
md.append('')
md.append('## 3条可证伪判断')
md.append(f'1. 当前这次抓取的密度第一名是 `{top10[0]["name"]}`。')
md.append(f'2. 当前这次抓取的平均最拥挤大区是 `{region_avg_sorted[0][0]}`。')
md.append('3. 本次有效国家记录数不少于 `180`。')
(out_dir / 'country-density-card.md').write_text('\n'.join(md), encoding='utf-8')
print(json.dumps({'status': status, 'countryCount': len(records), 'top1': top10[0]['name'], 'regionTop': region_avg_sorted[0][0]}, ensure_ascii=False))
