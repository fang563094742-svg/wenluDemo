# 一键启用 GitHub Pages

## 方式一：浏览器（最快，30秒）
1. 打开：https://github.com/fang563094742-svg/wenluDemo/settings/pages
2. Source 选择 **GitHub Actions**
3. 保存
4. 回到仓库首页 → Actions → 手动触发 "Deploy to GitHub Pages" workflow
5. 等 1-2 分钟，访问：https://fang563094742-svg.github.io/wenluDemo/landing.html

## 方式二：装 gh CLI 后命令行启用
```bash
brew install gh
gh auth login
gh api repos/fang563094742-svg/wenluDemo/pages -X POST -f build_type=workflow -f source='{"branch":"main","path":"/"}'
```

## 启用后：一键把推广文案集的占位符替换为真实链接
```bash
cd /Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenluDemo/public
sed -i '' 's|YOUR_LANDING_URL|https://fang563094742-svg.github.io/wenluDemo/landing.html|g' 推广文案集.md
git add 推广文案集.md && git commit -m "fix: 推广文案集链接指向 GitHub Pages" && git push
```
