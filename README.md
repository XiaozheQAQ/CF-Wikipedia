# CF-Wikipedia

用 Cloudflare Workers 搭建的中文维基百科镜像，面向无法直连维基的用户。单文件部署，免服务器，免费额度够日常用。

---

## 功能

- 全端支持：PC 走 Vector 皮肤，移动端自动切换 Minerva 皮肤
- 图标正常：CSS `url()` 全量改写，搜索框、汉堡菜单图标不丢失
- 音视频可播：替换掉 TimedMediaHandler，换成浏览器原生播放器
- 折叠区图片：MutationObserver 动态拦截，展开后图片正常加载
- 双层缓存：Cloudflare 边缘缓存 + Worker Cache API，静态资源 7 天缓存
- 防封禁：桌面 UA 池轮换，伪装请求头，隐藏 cf-ray 等标识
- 媒体代理：`/proxy-media/` 前缀仅代理白名单中的 Wikimedia 资源域名

## 部署

### 前置条件

- 一个 Cloudflare 账号（免费计划即可）
- 一个绑在 Cloudflare 上的域名（可选，不绑也能用 `*.workers.dev` 子域）

### 方法一：Dashboard 粘贴部署（最快）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)，左侧找到 **Workers & Pages**，点 **Create**
2. 选 **Create Worker**，给 Worker 起个名字，点 **Deploy**
3. 进入 Worker 详情页，点右上角 **Edit Code**
4. 把 `workers.js` 的内容整个粘贴进去，覆盖默认代码
5. 点 **Deploy**，部署完成

访问地址是 `https://你起的名字.你的账号.workers.dev`，在 Worker 详情页 **Triggers** 标签下能看到。

### 方法二：Wrangler CLI 部署

```bash
npm install -g wrangler
wrangler login
```

在本地新建一个目录，把 `workers.js` 放进去，创建 `wrangler.toml`：

```toml
name = "zh-wiki-mirror"
main = "workers.js"
compatibility_date = "2024-01-01"
```

然后：

```bash
wrangler deploy
```

### 绑定自定义域名

在 Worker 详情页 → **Triggers** → **Custom Domains** → **Add Custom Domain**，填入你的域名即可。

也可以在 Cloudflare DNS 里给域名加一条 CNAME 记录，指向 `你的worker名.你的账号.workers.dev`，Proxy 开启（橙云）。

---

## 配置

所有配置项都在 `workers.js` 顶部，直接改常量即可。

```js
// 上游（一般不用动）
const WIKI = 'zh.wikipedia.org';

// 媒体代理路径前缀
const MP = '/proxy-media/';

// 缓存时间（秒）
const TTL = {
  html:   1800,     // 文章页 30 分钟
  css:    86400,    // 样式 1 天
  static: 604800,   // 图片/字体 7 天
  media:  2592000,  // 音视频 30 天
  api:    300,      // API 5 分钟
};

// 按地区封锁（ISO 国家代码）
const BLOCKED_REGIONS = ['KP', 'SY', 'CU', 'IR'];

// 按 IP 封锁（填 IP 字符串数组）
const BLOCKED_IPS = [];
```

---

## 已知限制

- 只读镜像，编辑、登录、监视列表等写操作均返回 403
- 用户讨论页、个人页面等依赖登录态的内容显示不全
- 部分依赖第三方 CDN 的扩展功能（如地图）可能无法使用
- 带 Cookie 或 Authorization 的请求不会进入公共 Worker 缓存，以避免用户状态串缓存
- Cloudflare Workers 免费计划每天 10 万次请求，超出会 429；高流量建议升级 $5/月的 Paid 计划

---

## 免责声明

本项目仅用于学术研究和个人学习，不用于任何商业目的。维基百科内容遵循 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 协议，使用时请遵守相关许可证要求。

请在当地法律法规允许的范围内使用本项目，使用者需自行承担相关法律责任。

---

## License

[MIT](LICENSE)
