# 坤坤今天吃什么～

一个浅粉色的菜系与餐厅抽签网页，包含管理员维护、个人抽签记录和20天餐厅收集计划。

## 本地运行

需要 Node.js 20 或更高版本：

```bash
npm start
```

电脑可打开 `http://127.0.0.1:3000`。同一 Wi‑Fi 下的手机需要使用电脑的局域网地址，例如 `http://192.168.1.8:3000`。

## 正式上线

项目包含 `Dockerfile` 和 `render.yaml`，可直接部署到 Render，并通过 Supabase 免费保存长期数据。正式部署时必须设置：

- `SESSION_SECRET`：随机生成的长字符串，用于保护登录状态。
- `DATABASE_URL`：Supabase 数据库连接地址。

服务首次启动时会自动创建所需数据表。餐厅和菜系保存在 Supabase；个人抽签记录只保存在访问者自己的浏览器中。本地未配置 Supabase 时仍使用 `data/store.json`。
