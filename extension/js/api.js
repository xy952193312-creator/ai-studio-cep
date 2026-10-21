/**
 * api.js — AI 生图 API 适配层
 *
 * 设计原则：
 *   1. 面板内所有出图请求只走这里，不硬编码任何第三方接口/域名。
 *   2. 默认按 OpenAI 兼容协议（/v1/images/generations）发请求。
 *   3. 非标准服务走 protocol = 'custom'，由 buildCustomPayload() 定制，改这一处即可。
 *   4. 未配置 API 时自动降级为本地 mock，保证 UI 流程可完整演示。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util;

  /* ================= 配置解析 ================= */

  function cfg() {
    return HH.store.state.api;
  }

  function normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function isConfigured() {
    var c = cfg();
    return !!(normalizeBase(c.baseUrl) && String(c.apiKey || '').trim());
  }

  /**
   * 模型列表端点的候选地址
   * 用户填 https://host 或 https://host/v1 都要能命中，所以按顺序试。
   */
  function modelsUrls(base) {
    var b = normalizeBase(base);
    if (!b) return [];
    if (/\/v\d+$/i.test(b)) return [b + '/models', b + '/models?type=image'];
    return [b + '/v1/models', b + '/models'];
  }

  /** 解析额外请求头文本：每行 "Key: Value" */
  function parseExtraHeaders(text) {
    var out = {};
    String(text || '').split(/\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) {
        var k = line.slice(0, i).trim();
        var v = line.slice(i + 1).trim();
        if (k) out[k] = v;
      }
    });
    return out;
  }

  function buildHeaders(c) {
    var h = {
      'Content-Type': 'application/json'
    };
    if (c.apiKey) h['Authorization'] = 'Bearer ' + c.apiKey;
    return Object.assign(h, parseExtraHeaders(c.extraHeaders));
  }

  /* ================= 传输层 ================= */

  /**
   * Node 的 require（CEP 开了 --enable-nodejs 才有）
   * 优先级：window.cep_node → 全局 require（--mixed-context 下可用）
   */
  function nodeRequire() {
    try {
      if (global.cep_node && global.cep_node.require) return global.cep_node.require;
      if (typeof require === 'function') return require;
    } catch (e) { /* 没开 nodejs */ }
    return null;
  }

  /**
   * Node 通道总开关。
   *
   * 实测（PS 2025 + CEP 11）：manifest 里加 enable-nodejs 后，面板创建 20-120 秒内
   * PS 会整个退出，两次复现，回滚即恢复稳定。所以这里关掉 —— 代码留着，
   * 等换到不崩的 CEP 版本再打开即可。
   */
  var NODE_TRANSPORT = false;

  /** Node 通道是否可用（不可用则退回 fetch） */
  function hasNode() {
    return NODE_TRANSPORT && !!nodeRequire();
  }

  /** Node 的错误码翻成人话，"Failed to fetch" 那种提示对排查毫无帮助 */
  function nodeErrText(e) {
    var map = {
      ENOTFOUND: '域名解析失败，检查服务地址是否写错',
      ECONNREFUSED: '服务拒绝连接（端口不对或被防火墙拦了）',
      ECONNRESET: '连接被中断，通常是网关或代理提前断开',
      ETIMEDOUT: '连接超时',
      EPIPE: '连接被对方关闭',
      CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书链不完整，无法验证',
      DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书，无法验证'
    };
    if (e && e.code && map[e.code]) return map[e.code] + '（' + e.code + '）';
    return (e && e.message) || '未知网络错误';
  }

  /**
   * 用 Node 的 http/https 发请求，返回与 fetch Response 同形的对象
   * （ok / status / headers / text() / json()），上层不用区分通道。
   *
   * 为什么要绕开 fetch：
   *   面板右上角点 » 收起后，CEP 会挂起页面渲染进程，页面里发出的 fetch 连接
   *   会被取消 —— 表现为 "Failed to fetch"。可中转站那边四五十秒照跑，钱照扣，
   *   图却送不回来。挂在 Node 环境上的请求不受面板可见性影响。
   */
  function nodeRequest(url, options, timeoutSec) {
    // 先看总开关。以前这里直接 nodeRequire()，绕过了 NODE_TRANSPORT ——
    // 结果在 CEP 里 Node 明明可用（开关却是关的），请求还是走了 Node 通道，
    // 于是 FormData 被 String() 成 "[object FormData]" 塞给 http.request 报错。
    if (!NODE_TRANSPORT) return null;

    var req = nodeRequire();
    if (!req) return null;

    var nodeUrl, httpMod, httpsMod, BufferRef;
    try {
      nodeUrl = req('url');
      httpMod = req('http');
      httpsMod = req('https');
      BufferRef = req('buffer').Buffer;
    } catch (e) {
      return null;
    }

    var body = options && options.body;

    // FormData 是图生图（multipart）才用的。Node 的 http 收不了 FormData 对象，
    // 而且 boundary 只有浏览器知道 —— 这种情况必须留给 fetch 去发。
    // 以后若真把 NODE_TRANSPORT 打开，这里也是安全的：直接退回 fetch。
    if (body && typeof FormData !== 'undefined' && body instanceof FormData) return null;

    var headers = Object.assign({}, (options && options.headers) || {});
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = BufferRef.byteLength(String(body));
    }

    var limitMs = (timeoutSec || 120) * 1000;

    function once(targetUrl, hops) {
      var p = nodeUrl.parse(targetUrl);
      var mod = p.protocol === 'https:' ? httpsMod : httpMod;
      if (!mod) return Promise.reject(new Error('不支持的协议：' + p.protocol));

      return new Promise(function (resolve, reject) {
        var r = mod.request({
          protocol: p.protocol,
          hostname: p.hostname,
          port: p.port || (p.protocol === 'https:' ? 443 : 80),
          path: p.path,
          method: (options && options.method) || 'GET',
          headers: headers
        }, function (res) {
          // 跟一下重定向：中转站前面常挂网关，302 到真实节点
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
            res.resume();
            resolve(once(nodeUrl.resolve(targetUrl, res.headers.location), hops - 1));
            return;
          }

          var chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            var text = BufferRef.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers || {},
              text: function () { return Promise.resolve(text); },
              json: function () {
                return new Promise(function (ok, no) {
                  try { ok(JSON.parse(text)); } catch (e) { no(e); }
                });
              }
            });
          });
          res.on('error', function (e) { reject(new Error(nodeErrText(e))); });
        });

        r.setTimeout(limitMs, function () {
          r.destroy(new Error('请求超时（' + (timeoutSec || 120) + 's）'));
        });
        r.on('error', function (e) { reject(new Error(nodeErrText(e))); });

        if (body) r.write(body);
        r.end();
      });
    }

    return once(url, 5);
  }

  /* ================= 超时控制 ================= */

  function request(url, options, timeoutSec) {
    // 优先 Node 通道：折叠面板不会掐断它（详见 nodeRequest 注释）
    var viaNode = nodeRequest(url, options, timeoutSec);
    if (viaNode) {
      return viaNode.catch(function (err) {
        throw new Error('网络请求失败：' + (err && err.message ? err.message : '未知错误'));
      });
    }

    // 没有 Node（浏览器里预览、或 manifest 没开 --enable-nodejs）时退回 fetch
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, (timeoutSec || 120) * 1000);
    var opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error('请求超时（' + (timeoutSec || 120) + 's）');
      }
      throw new Error('网络请求失败：' + (err && err.message ? err.message : '未知错误'));
    });
  }

  /* ================= 测试连接 ================= */
  /**
   * 依次尝试 /models 与根路径，区分「不可达 / 鉴权失败 / 正常」
   * @returns {Promise<{ok:boolean, level:string, status:number, latency:number, message:string}>}
   */
  function testConnection(override) {
    var c = Object.assign({}, cfg(), override || {});
    var base = normalizeBase(c.baseUrl);
    if (!base) {
      return Promise.resolve({ ok: false, level: 'err', status: 0, latency: 0, message: '请先填写 API 服务地址' });
    }
    if (!/^https?:\/\//i.test(base)) {
      return Promise.resolve({ ok: false, level: 'err', status: 0, latency: 0, message: '地址需以 http:// 或 https:// 开头' });
    }

    var t0 = Date.now();
    var headers = buildHeaders(c);
    delete headers['Content-Type'];

    function probe(url) {
      return request(url, { method: 'GET', headers: headers }, Math.min(c.timeout || 120, 20))
        .then(function (res) {
          return { status: res.status, ok: res.ok, url: url };
        });
    }

    // 依次尝试 /v1/models、/models、根路径；遇到 404 才继续往下换
    var candidates = modelsUrls(base).concat([base]);
    function run(i) {
      if (i >= candidates.length) return Promise.reject(new Error('所有候选端点都不可达'));
      return probe(candidates[i]).then(function (r) {
        if (r.status === 404 && i + 1 < candidates.length) return run(i + 1);
        return r;
      }, function () {
        if (i + 1 < candidates.length) return run(i + 1);
        throw new Error('所有候选端点都不可达');
      });
    }

    return run(0)
      .then(function (r) {
        var latency = Date.now() - t0;
        var status = r.status;

        if (status >= 200 && status < 300) {
          return { ok: true, level: 'ok', status: status, latency: latency,
            message: '服务可达，鉴权通过（HTTP ' + status + '，' + latency + 'ms）' };
        }
        if (status === 401 || status === 403) {
          return { ok: false, level: 'warn', status: status, latency: latency,
            message: '服务可达，但鉴权失败（HTTP ' + status + '）。请检查 API Key 是否正确/是否已过期。' };
        }
        if (status === 404) {
          return { ok: true, level: 'warn', status: status, latency: latency,
            message: '服务可达（HTTP 404）。接口路径 ' + c.path + ' 可能不匹配，生图时请确认路径。' };
        }
        return { ok: false, level: 'err', status: status, latency: latency,
          message: '服务返回异常状态 HTTP ' + status + '，请检查服务地址与网关配置。' };
      })
      .catch(function (err) {
        return { ok: false, level: 'err', status: 0, latency: Date.now() - t0,
          message: err.message + '。常见原因：地址写错、服务未启动、被防火墙拦截。' };
      });
  }

  /* ================= 拉取模型列表 ================= */
  /**
   * GET {base}/v1/models（OpenAI / New API / One API 通用）
   * 返回结构：{ ok, models:[{id, image:boolean}], status, latency, message }
   */
  function fetchModels(override) {
    var c = Object.assign({}, cfg(), override || {});
    var base = normalizeBase(c.baseUrl);
    if (!base) {
      return Promise.resolve({ ok: false, models: [], status: 0, latency: 0,
        message: '请先填写 API 服务地址' });
    }
    if (!/^https?:\/\//i.test(base)) {
      return Promise.resolve({ ok: false, models: [], status: 0, latency: 0,
        message: '地址需以 http:// 或 https:// 开头' });
    }

    var t0 = Date.now();
    var headers = buildHeaders(c);
    delete headers['Content-Type'];

    var candidates = modelsUrls(base);

    function run(i) {
      if (i >= candidates.length) return Promise.reject(new Error('所有候选端点都不可达'));
      return request(candidates[i], { method: 'GET', headers: headers }, Math.min(c.timeout || 120, 20))
        .then(function (res) {
          // 只有 404 才换下一个地址；401/403 直接返回，让上层提示 Key 问题
          if (res.status === 404 && i + 1 < candidates.length) return run(i + 1);
          return res;
        }, function (err) {
          if (i + 1 < candidates.length) return run(i + 1);
          throw err;
        });
    }

    return run(0).then(function (res) {
      var latency = Date.now() - t0;

      if (res.status === 401 || res.status === 403) {
        return { ok: false, models: [], status: res.status, latency: latency,
          message: '鉴权失败（HTTP ' + res.status + '）：API Key 无效、已过期或无该模型权限' };
      }
      if (res.status === 404) {
        return { ok: false, models: [], status: 404, latency: latency,
          message: '未找到模型列表接口（HTTP 404）。请确认服务地址，或服务端未开放 /v1/models' };
      }
      if (!res.ok) {
        return { ok: false, models: [], status: res.status, latency: latency,
          message: '拉取失败（HTTP ' + res.status + '）' };
      }

      return res.json().then(function (json) {
        // 兼容：OpenAI {data:[]} / 部分服务 {models:[]} / 数组直出
        var raw = (json && (json.data || json.models || json.result)) || (Array.isArray(json) ? json : []);
        var out = [];

        raw.forEach(function (m) {
          var id = '';
          var kinds = [];
          if (typeof m === 'string') {
            id = m;
          } else if (m) {
            id = m.id || m.name || m.model || '';
            kinds = m.supported_endpoint_types || m.endpoint_types || m.type || [];
          }
          if (!id) return;
          if (typeof kinds === 'string') kinds = [kinds];

          // New API 会带 supported_endpoint_types，用来判断是不是生图模型
          var isImage = kinds.some(function (k) {
            k = String(k).toLowerCase();
            return k.indexOf('image') >= 0;
          });

          out.push({ id: String(id), image: isImage });
        });

        // 去重（同一模型可能因端点类型出现多次）
        var seen = {};
        out = out.filter(function (m) {
          if (seen[m.id]) return false;
          seen[m.id] = 1;
          return true;
        });

        // 生图模型排前面，其余按字母序
        out.sort(function (a, b) {
          if (a.image !== b.image) return a.image ? -1 : 1;
          return a.id.localeCompare(b.id);
        });

        if (!out.length) {
          return { ok: false, models: [], status: res.status, latency: latency,
            message: '接口返回成功，但列表为空 —— 该 Key 可能未开通任何模型' };
        }

        var imgCount = out.filter(function (m) { return m.image; }).length;
        return { ok: true, models: out, status: res.status, latency: latency,
          message: '拉取到 ' + out.length + ' 个模型' + (imgCount ? '（其中 ' + imgCount + ' 个标注为生图）' : '') };
      });
    }).catch(function (err) {
      return { ok: false, models: [], status: 0, latency: Date.now() - t0,
        message: err.message || '拉取失败' };
    });
  }

  /* ================= 请求体构造 ================= */

  /** 比例 -> 像素尺寸（2K 档，可按你的服务需要调整） */
  function ratioToSize(ratio) {
    var map = {
      '1:1': '1024x1024',
      '4:3': '1152x864',
      '3:4': '864x1152',
      '16:9': '1280x720',
      '9:16': '720x1280',
      '3:2': '1200x800',
      '2:3': '800x1200'
    };
    return map[ratio] || '1024x1024';
  }

  /* ================= 模型能力：生图质量档位 =================
   *
   * 为什么要有这张表，而不是页面上写死一个 low/medium/high 下拉：
   *   quality 的合法取值是「跟模型走」的。给 gpt-image-1 发 xhigh，
   *   服务端会直接回 400；给 gpt-image-2.5-sunburst 只留到 high，
   *   又白瞎了它最贵的两档。所以选项必须由模型名推导，不能写死。
   *
   *   依据（OpenAI Image API 公开文档 + 2026-10-20 对中转站 /v1/models 实测）：
   *     gpt-image-1 / 1-mini / 1.5 / gpt-image-2[-(1k|2k|4k|x)]  -> auto low medium high
   *     gpt-image-2.5[-flare|-sunburst][-1k|-2k|-4k|-x|-(快照)]  -> 上述 + xhigh max
   *   其它系列（midjourney / grok-imagine / gemini-image …）不认这个字段，
   *   返回 null 表示「这一项根本不显示」—— 显示一个无效选项比不显示更糟。
   *
   *   ⚠ 实测（某中转服务，2026-10-20）：该中转站**不校验 quality**，
   *     传非法值照样 200 并起任务，所以「发错档位会 400」在这里不成立。
   *     但也别指望它生效 —— low / high / xhigh 三档产出的图尺寸（1254×1254）
   *     与文件大小（1.9–2.4MB）都在随机波动范围内，没有档次差异。
   *     结论：字段按标准传，能不能生效取决于上游是否透传。
   */

  /** 各档位的中文说明，UI 直接取用，避免页面里再抄一遍 */
  var QUALITY_LABEL = {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高'
  };

  /**
   * 该模型支持的质量档位
   * @param {string} model
   * @returns {string[]|null} null = 不显示这一项
   */
  function qualityOptions(model) {
    var m = String(model || '').trim().toLowerCase();
    // 只认 gpt-image 家族；别的模型塞 quality 没意义
    if (!/^gpt-image/.test(m)) return null;

    // 2.5 才支持 xhigh / max。
    // 注意这里不能只认 -sunburst / -flare 后缀：中转站的模型名里还有
    // 不带后缀的 gpt-image-2.5、以及 -x 变体，只匹配后缀会把它们误判成四档。
    if (/^gpt-image-2\.5(\b|[-.])/.test(m)) {
      return ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
    }
    return ['auto', 'low', 'medium', 'high'];
  }

  /** 把用户存的档位收敛到该模型真正支持的范围内 */
  function normalizeQuality(model, quality) {
    var list = qualityOptions(model);
    if (!list) return '';                       // 该模型不认 quality，一律不发
    return list.indexOf(quality) >= 0 ? quality : 'auto';
  }

  /** OpenAI 兼容请求体 */
  function buildOpenAIPayload(o) {
    var body = {
      model: o.model,
      prompt: o.negative ? (o.prompt + '\n\n[Negative]: ' + o.negative) : o.prompt,
      n: o.count || 1,
      size: o.size || ratioToSize(o.ratio),
      response_format: 'b64_json'
    };
    // 生图质量：仅当模型认这个字段时才发。绝不硬塞 —— 老模型会 400
    var q = normalizeQuality(o.model, o.quality);
    if (q) body.quality = q;
    // 异步模式：服务端立刻返回任务 ID，结果靠轮询拿。
    // 这样面板收起/崩溃都不影响出图（见 generateTask 注释）
    if (o.async) body.async = true;
    // 图生图 / 改图：多数兼容服务用 image 字段接收 base64 或 URL
    if (o.mode === 'edit' && o.images && o.images.length) {
      body.image = o.images.length === 1 ? o.images[0] : o.images;
    }
    return body;
  }

  /**
   * 【预留钩子】非标服务商在此组装请求体
   * 改这里即可对接你自己的 API，无需动 UI 层。
   *
   * @param {object} o { mode, prompt, negative, model, size, count, images }
   * @param {object} c 当前 API 配置
   * @returns {object} 请求体
   */
  function buildCustomPayload(o, c) {
    // === 示例：按需替换字段名 ===
    return {
      model: o.model,
      prompt: o.prompt,
      negative_prompt: o.negative || undefined,
      width: parseInt(String(o.size || '1024x1024').split('x')[0], 10),
      height: parseInt(String(o.size || '1024x1024').split('x')[1], 10),
      batch_size: o.count || 1,
      init_images: (o.images || []).map(function (s) { return String(s).split(',')[1] || s; }),
      // 质量档位：同样只在该模型认的时候才带（custom 服务商可自行改名，如 quality_level）
      quality: normalizeQuality(o.model, o.quality) || undefined,
      // custom_extra: c.someField,
      response_format: 'b64_json'
    };
  }

  /**
   * 归一化各家返回结构
   *
   * ⚠ 一个必须防的坑（2026-10-20 实测某中转服务）：
   *   任务失败时，服务端不返回空 data，而是把**中文错误文案塞进 data[0].url**：
   *     {"status":"failed","data":[{"url":"非常抱歉，生成的图片可能违反了…"}]}
   *   原来的实现看到 it.url 有值就当图片收下，于是：
   *     - 失败任务被当成成功
   *     - 面板拿到一段中文当图片地址，结果显示成一张破图
   *     - 真正的错误原因（error.message）被丢掉
   *   所以这里必须校验「像不像图片地址」，不像就丢掉。
   */
  function looksLikeImage(src) {
    var s = String(src || '').trim();
    if (!s) return false;
    return /^https?:\/\//i.test(s) || /^data:image\//i.test(s);
  }

  function parseResponse(json) {
    var items = [];
    var arr = json && (json.data || json.images || json.output || json.result || json.artifacts);
    if (!Array.isArray(arr)) arr = [];

    arr.forEach(function (it) {
      if (typeof it === 'string') {
        // 裸字符串：是合法地址就收，否则当 base64（但要先排除中文错误文案）
        if (looksLikeImage(it)) items.push(it);
        else if (/^[A-Za-z0-9+/=\s]+$/.test(it) && it.length > 64) {
          items.push('data:image/png;base64,' + it);
        }
        return;
      }
      if (!it) return;
      if (it.b64_json) items.push('data:image/png;base64,' + it.b64_json);
      else if (it.base64) items.push('data:image/png;base64,' + it.base64);
      else if (it.url && looksLikeImage(it.url)) items.push(it.url);
      else if (it.image && looksLikeImage(it.image)) items.push(it.image);
      // it.url 不像图片（多半是错误文案）→ 丢弃，交给调用方看 error 字段
    });

    return items;
  }

  /** 从响应里挖出可读的失败原因（各家结构不一） */
  function errorTextOf(json) {
    if (!json) return '';
    if (json.error) {
      if (typeof json.error === 'string') return json.error;
      if (json.error.message) return String(json.error.message);
    }
    if (json.message) return String(json.message);
    // 有的把原因塞在 data[0].url 里（就是上面那个坑），兜住
    var d = json.data && json.data[0];
    if (d && d.url && !looksLikeImage(d.url)) return String(d.url);
    return '';
  }

  /* ================= Mock（未配置时的本地演示） ================= */

  /**
   * 生成占位图，仅用于验证 UI 流程
   * 有参考图时：基于参考图叠加标注；无参考图时：按提示词哈希生成渐变
   */
  function mockImage(o) {
    var size = (o.size || ratioToSize(o.ratio)).split('x');
    var w = parseInt(size[0], 10) || 1024;
    var h = parseInt(size[1], 10) || 1024;

    function build(baseImg) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');

      if (baseImg) {
        var scale = Math.min(w / baseImg.width, h / baseImg.height);
        var dw = baseImg.width * scale, dh = baseImg.height * scale;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(baseImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else {
        var hue = U.hash(o.prompt) % 360;
        var g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, 'hsl(' + hue + ', 62%, 34%)');
        g.addColorStop(0.55, 'hsl(' + ((hue + 40) % 360) + ', 55%, 22%)');
        g.addColorStop(1, 'hsl(' + ((hue + 90) % 360) + ', 48%, 14%)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        // 装饰圆
        ctx.globalAlpha = 0.16;
        for (var i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.arc(w * (0.2 + i * 0.16), h * (0.3 + (i % 3) * 0.2), w * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // 底部信息条
      var barH = Math.max(56, Math.round(h * 0.09));
      var bg = ctx.createLinearGradient(0, h - barH, 0, h);
      bg.addColorStop(0, 'rgba(0,0,0,0)');
      bg.addColorStop(1, 'rgba(0,0,0,0.78)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, h - barH, w, barH);

      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '600 ' + Math.round(w * 0.026) + 'px "Microsoft YaHei", sans-serif';
      var text = (o.prompt || '(空提示词)').slice(0, 40);
      ctx.fillText(text, Math.round(w * 0.035), h - Math.round(barH * 0.5));

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = Math.round(w * 0.019) + 'px "Microsoft YaHei", sans-serif';
      ctx.fillText('MOCK 预览 · 未配置 API · ' + (o.model || 'default') + ' · ' + w + '×' + h,
        Math.round(w * 0.035), h - Math.round(barH * 0.5) + Math.round(w * 0.032));

      return c.toDataURL('image/png');
    }

    if (o.mode === 'edit' && o.images && o.images.length) {
      return U.loadImg(o.images[0]).then(build).catch(function () { return build(null); });
    }
    return Promise.resolve(build(null));
  }

  /* ================= 主入口：生成 ================= */
  /**
   * @param {object} o
   *   mode    'edit' | 'txt'
   *   prompt  提示词
   *   negative 负向提示词
   *   model   模型名
   *   ratio   比例
   *   size    直接指定像素（可选，优先级高于 ratio）
   *   count   张数
   *   images  dataURL 数组（改图/参考图）
   * @returns {Promise<{items:string[], mock:boolean, raw:any}>}
   */
  function generate(o) {
    var c = cfg();
    var t0 = Date.now();
    var opts = Object.assign({
      mode: 'txt',
      prompt: '',
      negative: '',
      model: c.model,
      ratio: '1:1',
      count: 1,
      quality: '',       // 空 = auto（在 buildOpenAIPayload 里落默认）
      images: []
    }, o || {});

    opts.size = opts.size || ratioToSize(opts.ratio);
    opts.model = opts.model || c.model || 'default';

    // 未配置 -> mock
    if (!isConfigured()) {
      var tasks = [];
      for (var i = 0; i < (opts.count || 1); i++) tasks.push(mockImage(opts));
      return Promise.all(tasks).then(function (list) {
        logApi('info', '未配置 API，出 mock 图 ' + list.length + ' 张（不是真实请求）');
        return { items: list, mock: true, raw: null };
      });
    }

    return submitOnce(c, opts, c.timeout || 120).then(function (r) {
      var job = r.job, res = r.res, text = r.text;
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }

      if (!res.ok) {
        var msg = (json && (json.error && (json.error.message || json.error) || json.message)) || text.slice(0, 160) || ('HTTP ' + res.status);
        throw new Error('接口返回 ' + res.status + '：' + msg);
      }
      if (!json) throw new Error('返回内容不是合法 JSON：' + String(text).slice(0, 120));

      var items = parseResponse(json);
      if (!items.length) {
        // 优先把服务端给的原因带出来（内容审查、余额不足等都在这里）
        var why = errorTextOf(json);
        throw new Error(why || '接口返回成功但未解析到图片字段（支持 data[].b64_json / data[].url）');
      }
      logApi('info', '完成 用时 ' + dur(Date.now() - t0) + ' 图片 ' + items.length +
        ' 张 端点=' + (job.isForm ? 'edits' : 'generations'));
      return { items: items, mock: false, raw: json, viaEdits: job.isForm };
    }).catch(function (e) {
      // 提交那一行已经记了端点和张数，这里只补「为什么没成」和耗时
      logApi('error', '失败 用时 ' + dur(Date.now() - t0) + ' ' + (e && e.message));
      throw e;
    });
  }

  /* ================= 异步任务：提交 + 轮询 =================
   *
   * 为什么必须有这一步：
   *   同步出图要 40-60 秒，这期间面板一旦被收起（»），CEP 会冻结页面、
   *   掐断正在等待的 fetch —— 面板收到 "Failed to fetch"，可中转站那边照跑照扣费，
   *   图却永远送不回来。等于花了钱什么都没拿到。
   *
   *   异步模式下，提交请求 0.5 秒就返回，只带一个 task_id；之后我们用
   *   一个个短请求去轮询。每个轮询请求只有几百毫秒，被掐断也无所谓，
   *   下一轮接着问就行 —— 任务在服务端照常跑，结果随时能凭 ID 取回。
   *
   * 实测（某中转服务，2026-10）：
   *   POST /v1/images/generations  { ..., "async": true }
   *   -> {"id":"task_xxx","status":"queued","progress":"20%","created_at":...}
   *   GET  /v1/images/generations/task_xxx
   *   -> {"status":"queued|in_progress|completed","progress":"60%",
   *       "data":[{"url":"https://.../0.jpg"}]}
   */

  /** 轮询间隔与总时限 */
  var POLL_MS = 6000;
  var TASK_MAX_MS = 15 * 60 * 1000;   // 15 分钟，文档建议不要过早判超时

  /**
   * 连续查询失败几次才算真失败
   *
   * 查询是 GET，重试成本近乎为零；过早判死的代价是用户以为要重跑、再扣一次钱。
   * 后台 tasks.js 的 follow 本来就是「问失败了下一轮接着问」，这里把前台拉齐。
   */
  var POLL_FAIL_MAX = 5;

  /**
   * 图生图专用端点：/v1/images/edits
   *
   * ⚠ 为什么必须换端点（2026-10-20 四轮对照实测某中转服务）：
   *   在 /v1/images/generations 的 JSON 里塞 image 字段 → 服务端**静默丢弃**，
   *   返回 200、任务照跑、图照出，但出图内容和不带图时一模一样（只跟 prompt 走）。
   *   用纯灰噪点图做排除性测试也没能污染产出 —— 说明它根本没读那张图。
   *
   *   而 /v1/images/edits（multipart/form-data）是完全可用的：
   *     - 无鉴权 401（端点存在）
   *     - 带图 200，usage 里 image_tokens 非 0（图真被读了）
   *     - 支持 async:true，返回同形 task id
   *     - 轮询仍走 GET /v1/images/generations/{id}（同一个任务表）
   *
   *   所以策略是：有图走 edits、无图走 generations。这正是 OpenAI 官方架构，
   *   不是我们为某家中转站打的补丁。
   */
  function editsUrlFor(base, c) {
    var b = normalizeBase(base);
    // 用户自定义了 path 就尊重之（有人把 path 填成整段镜像地址），否则标准 /v1/images/edits
    var p = (c && c.path) ? c.path : 'v1/images/generations';
    p = String(p).replace(/\/+$/, '');
    if (/generations$/i.test(p)) p = p.replace(/generations$/i, 'edits');
    else if (!/edits$/i.test(p)) p = 'v1/images/edits';
    return b + (p.charAt(0) === '/' ? p : '/' + p);
  }

  /** dataURL -> Blob（FormData 只吃 Blob/File，不能直接塞 base64 字符串） */
  function dataUrlToBlob(dataUrl) {
    var s = String(dataUrl || '');
    var m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(s);
    if (!m) return null;
    var mime = m[1] || 'image/png';
    var bin;
    if (m[2]) {
      bin = atob(m[3]);
    } else {
      bin = decodeURIComponent(m[3]);
    }
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /** 按 mime 猜扩展名，服务端有些解析器靠 filename 判类型 */
  function extOfMime(mime) {
    if (/jpe?g/i.test(mime)) return 'jpg';
    if (/webp/i.test(mime)) return 'webp';
    return 'png';
  }

  /**
   * 组装 edits 的 multipart 表单
   * @returns {FormData|null} 没有可用图时返回 null
   *
   * 关于多图（2026-10-20 实测某中转服务，详见 _img2img_test/FINDINGS.md）：
   *   - 服务端**按张计费**：image_tokens 随张数严格线性（1 张 415 / 2 张 830 / 3 张 1245），
   *     说明每一张都被读进去了，不存在「只收第一张、其余静默丢弃」。
   *   - 视觉上**会融合**：红/黄/蓝三张喂进去，三种颜色都出现在同一张输出里。
   *   - 但**不保证每张都体现**：绿+橙能合成双色块，橙+绿却只出橙 ——
   *     模型会按提示词的语义自己取舍。这是模型行为，不是接口契约。
   *   - 字段名 `image` 和 `image[]` 两种都被接受，这里用重复的同名 `image`。
   *
   * 所以按界面顺序原样 append，不排序、不去重、不在这里截断（上限由页面 MAX_IMAGES 管）。
   * 顺序是有语义的：images[0] 是底图/主图，语义冲突时由它胜出。
   */
  function buildEditsForm(o) {
    var imgs = (o.images || []).filter(Boolean);
    if (!imgs.length) return null;

    var fd = new FormData();
    fd.append('model', o.model);
    fd.append('prompt', o.negative ? (o.prompt + '\n\n[Negative]: ' + o.negative) : o.prompt);
    fd.append('n', String(o.count || 1));
    fd.append('size', o.size || ratioToSize(o.ratio));
    fd.append('response_format', 'b64_json');
    if (o.async) fd.append('async', 'true');

    // quality：跟 generations 一样按模型收敛，不认这个字段的模型一律不发
    var q = normalizeQuality(o.model, o.quality);
    if (q) fd.append('quality', q);

    // 多图：字段名统一用 image（OpenAI 支持 image[] 数组语义），
    // 部分实现只认单数，多张时按同名重复提交是最兼容的写法
    imgs.forEach(function (src, i) {
      var blob = dataUrlToBlob(src);
      if (!blob) return;
      fd.append('image', blob, 'image-' + (i + 1) + '.' + extOfMime(blob.type));
    });

    return fd;
  }

  function endpointFor(base, c) {
    return normalizeBase(base) + (c.path && c.path.charAt(0) === '/' ? c.path : '/' + (c.path || 'v1/images/generations'));
  }

  /* ================= 请求日志（A3） =================
   *
   * 为什么现在才补：之前 api.js 一行 diag 都没写过。出图失败后翻日志，
   * 看不到请求了哪个端点、走的是 edits 还是 generations、传了几张、耗时多少 ——
   * 而这几项恰恰是「为什么这次没出图」的全部线索。
   *
   * 粒度（三条，别多也别少）：
   *   1. 提交必记：mode / 端点 / 张数 —— 「我到底走的哪个端点」只靠这一行回答
   *   2. 轮询只在**状态跃变**时记：稳态 6 秒一次，15 分钟能刷 150 行，
   *      全记会淹没真正关键的那几行，只有 queued→processing→completed 才值一行
   *   3. 终态必记且带总耗时：成功写「用时 Ns 图片 M 张」；失败/超时写原因 + taskId
   *      （taskId 是断点续取的凭据，日志里留一份，等于给重跑留了退路）
   *
   * 红线：不记 apiKey、不记 header、不记 body —— diag.js 顶层注释已定，导出不泄密。
   */
  function logApi(level, msg) {
    try {
      if (global.HH && HH.diag) HH.diag.log(level, 'api', msg);
    } catch (e) { /* 记日志失败绝不能影响主流程 */ }
  }

  /** 只留 host+path，去掉 query —— 万一谁把 key 拼在 URL 上也不会泄出去 */
  function safeUrl(u) {
    return String(u || '').split('?')[0];
  }

  /** 毫秒 -> 「42.3s」/「2m05s」 */
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 100) / 10);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = Math.round(s % 60);
    return m + 'm' + (r < 10 ? '0' : '') + r + 's';
  }

  /**
   * 发一次「生图或改图」请求，两种协议自动分流
   *
   * 抽出来是因为有两条调用链（同步 generate / 异步 createTask）都要判断一次，
   * 判断逻辑重复两遍迟早不一致 —— 一处改了另一处忘，就会出现
   * 「预览能出图、生成不出图」这种最难查的问题。
   *
   * @returns {Promise<{url:string, isForm:boolean}>}
   */
  function submitGenRequest(c, opts, timeoutSec) {
    var useEdit = opts.mode === 'edit' && (opts.images || []).length > 0
      && c.protocol !== 'custom';        // custom 服务商保持自己的 JSON 协议不变

    if (!useEdit) {
      var url = endpointFor(c.baseUrl, c);
      logApi('info', 'submit mode=txt 图片 0 张 url=' + safeUrl(url));
      var body = c.protocol === 'custom'
        ? Object.assign(buildCustomPayload(opts, c), opts.async ? { async: true } : {})
        : buildOpenAIPayload(opts);
      return Promise.resolve({
        url: url,
        isForm: false,
        promise: request(url, {
          method: 'POST',
          headers: buildHeaders(c),
          body: JSON.stringify(body)
        }, timeoutSec)
      });
    }

    // —— 有图：走 multipart ——
    var fd = buildEditsForm(opts);
    if (!fd) {   // 理论上进不来，兜底回退到普通生成
      var u2 = endpointFor(c.baseUrl, c);
      logApi('warn', 'submit mode=edit 但表单为空，退回 txt url=' + safeUrl(u2));
      return Promise.resolve({
        url: u2, isForm: false,
        promise: request(u2, { method: 'POST', headers: buildHeaders(c), body: JSON.stringify(buildOpenAIPayload(opts)) }, timeoutSec)
      });
    }

    // ⚠ 绝不能手写 Content-Type：multipart 的 boundary 由浏览器生成，
    //   自己写死一个 boundary 而 body 里没有对应分隔符 = 服务端解析失败或静默忽略
    var h = buildHeaders(c);
    delete h['Content-Type'];
    h['Authorization'] = h['Authorization'] || ('Bearer ' + c.apiKey);

    var eurl = editsUrlFor(c.baseUrl, c);
    logApi('info', 'submit mode=edit 图片 ' + (opts.images || []).filter(Boolean).length +
      ' 张 url=' + safeUrl(eurl));
    return Promise.resolve({
      url: eurl,
      isForm: true,
      promise: request(eurl, { method: 'POST', headers: h, body: fd }, timeoutSec)
    });
  }

  /* ================= 参考图上限：听服务端的，别听我们写死的 =================
   *
   * 为什么不能写死：MAX_IMAGES=9 是 2026-10-20 对某中转服务实测出来的
   * （传 10 张直接 400 `参考图最多 9 张`）。但用户填的是**自己的** API 地址，
   * 换一家服务商、或者这家哪天改规则，写死的 9 立刻就错 —— 而且这次没人会去实测。
   *
   * 所以改成：正常按上限发；被「参考图太多」拒了，就从错误文案里读出真实上限，
   * 截掉多余的**自动重试一次**，并把这个数记住，页面下次按它收敛。
   */

  /** 服务端亲口说的上限（0 = 还没被纠正过） */
  var refLimitSeen = 0;

  /**
   * 从错误文案里抠出「最多几张」
   *
   * 中英两种写法都得认：中文服务商写「参考图最多 9 张」，
   * 英文服务商大概率是 "at most 9 images" / "up to 9 images"。
   * @returns {number} 抠不到就返回 0（调用方看到 0 就别重试）
   */
  function parseRefLimit(msg) {
    var s = String(msg || '');
    var m = /最多\s*(\d+)\s*张/.exec(s);
    if (!m) m = /(?:at\s+most|up\s+to|no\s+more\s+than|maximum(?:\s+of)?|limit(?:ed)?\s+to)\s+(\d+)/i.exec(s);
    if (!m) m = /(\d+)\s+(?:images?|references?|files?)\s+(?:at\s+)?(?:most|maximum)/i.exec(s);
    var n = m ? parseInt(m[1], 10) : 0;
    // 抠出来的数必须合理：至少 1 张、不超过我们自己的硬上限 20（再多就是误判）
    return (n >= 1 && n <= 20) ? n : 0;
  }

  /** 记下服务端给的上限，取更小值（服务端只会越说越严） */
  function noteRefLimit(msg) {
    var n = parseRefLimit(msg);
    if (n > 0 && (!refLimitSeen || n < refLimitSeen)) {
      refLimitSeen = n;
      logApi('warn', '服务端限制参考图最多 ' + n + ' 张，已按此调整上限');
    }
    return n;
  }

  /** 从失败响应里取出错误文案（跟 createTask 里的取法保持一致） */
  function failTextOf(res, text, json) {
    return (json && ((json.error && (json.error.message || json.error)) || json.message)) ||
      String(text || '').slice(0, 200) || ('HTTP ' + (res && res.status));
  }

  /**
   * 发一次请求；若被「参考图太多」拒绝，就按服务端说的张数截掉重发一次
   *
   * @returns {Promise<{job:object, res:object, text:string}>}
   */
  function submitOnce(c, opts, timeoutSec) {
    return submitGenRequest(c, opts, timeoutSec).then(function (job) {
      return job.promise.then(function (res) {
        return res.text().then(function (text) {
          if (res.ok) return { job: job, res: res, text: text };

          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
          var msg = failTextOf(res, text, json);
          var n = noteRefLimit(msg);
          var imgs = opts.images || [];

          // 只有「确实是因为参考图太多」才重试：抠不出张数、或本来就没超限，别瞎试
          if (n > 0 && imgs.length > n) {
            var cut = Object.assign({}, opts, { images: imgs.slice(0, n) });
            logApi('warn', '参考图 ' + imgs.length + ' 张超出上限，截到前 ' + n + ' 张重试一次');
            return submitGenRequest(c, cut, timeoutSec).then(function (j2) {
              return j2.promise.then(function (r2) {
                return r2.text().then(function (t2) { return { job: j2, res: r2, text: t2 }; });
              });
            });
          }

          return { job: job, res: res, text: text };
        });
      });
    });
  }

  /** 各家 task id 字段不统一，这里兼容常见写法 */
  function taskIdOf(json) {
    if (!json) return '';
    if (json.id) return String(json.id);
    if (json.task_id) return String(json.task_id);
    if (json.taskId) return String(json.taskId);
    if (json.data && json.data[0] && json.data[0].id) return String(json.data[0].id);
    return '';
  }

  /**
   * 提交异步任务
   * @returns {Promise<{taskId:string, status:string, progress:string, raw:object}>}
   */
  function createTask(o) {
    var c = cfg();
    var opts = Object.assign({ mode: 'txt', prompt: '', negative: '', quality: '', images: [], count: 1 }, o || {});
    opts.size = opts.size || ratioToSize(opts.ratio);
    opts.model = opts.model || c.model || 'default';
    opts.async = true;

    return submitOnce(c, opts, Math.min(c.timeout || 120, 60)).then(function (r) {
      var job = r.job, res = r.res, text = r.text;
      var json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }

      if (!res.ok) {
        var msg = (json && (json.error && (json.error.message || json.error) || json.message)) || String(text).slice(0, 160) || ('HTTP ' + res.status);
        throw new Error('接口返回 ' + res.status + '：' + msg);
      }
      var id = taskIdOf(json);
      if (!id) {
        // 服务端没走异步（忽略 async 参数）时，可能直接把图返回了
        var items = parseResponse(json);
        if (items.length) return { taskId: '', status: 'completed', progress: '100%', items: items, raw: json, viaEdits: job.isForm };
        throw new Error('提交成功但没拿到任务 ID，返回：' + String(text).slice(0, 160));
      }
      return { taskId: id, status: (json && json.status) || 'queued', progress: (json && json.progress) || '', raw: json, viaEdits: job.isForm };
    });
  }

  /**
   * 查一次任务状态
   * @returns {Promise<{done:boolean, failed:boolean, status:string, progress:string, urls:string[], raw:object}>}
   */
  function pollTask(taskId) {
    var c = cfg();
    var url = endpointFor(c.baseUrl, c) + '/' + encodeURIComponent(taskId);

    return request(url, { method: 'GET', headers: buildHeaders(c) }, Math.min(c.timeout || 120, 30))
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }

          if (!res.ok) {
            var msg = (json && (json.message || (json.error && json.error.message))) || String(text).slice(0, 160) || ('HTTP ' + res.status);
            // task_not_exist：ID 写错或过期
            if (/not_exist|not_found/i.test(msg)) {
              return { done: true, failed: true, status: 'not_exist', progress: '', urls: [], raw: json, error: '任务不存在（ID 写错或已过期）' };
            }
            throw new Error('查询失败 ' + res.status + '：' + msg);
          }

          var status = (json && (json.status || json.state)) || '';
          var progress = (json && (json.progress || json.percentage)) || '';
          var urls = [];

          if (/completed|succeeded|success/i.test(status)) {
            (parseResponse(json) || []).forEach(function (u) { urls.push(u); });
            // completed 也可能一张有效图都没有（全被内容审查拦下、或返回了非图片内容）。
            // 这时不能当成成功往下走，否则上层拿到空数组，只会显示「共 0 张」。
            if (!urls.length) {
              return {
                done: true, failed: true, status: status, progress: progress,
                urls: [], raw: json,
                error: errorTextOf(json) || '任务已完成，但服务端没有返回有效图片'
              };
            }
            return { done: true, failed: false, status: status, progress: progress, urls: urls, raw: json };
          }
          if (/failed|error|cancelled|canceled/i.test(status)) {
            // errorTextOf 会连 data[0].url 里那段中文错误文案一起兜住
            var em = errorTextOf(json) || '任务失败';
            return { done: true, failed: true, status: status, progress: progress, urls: [], raw: json, error: String(em) };
          }
          return { done: false, failed: false, status: status || 'queued', progress: progress, urls: [], raw: json };
        });
      });
  }

  /** 直链转 dataURL（跨域已关，面板里可以直接取） */
  function urlToDataUrl(url) {
    if (/^data:/i.test(url)) return Promise.resolve(url);
    return fetch(url, { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('下载图片失败 HTTP ' + res.status);
      return res.blob();
    }).then(function (blob) {
      return new Promise(function (ok, no) {
        var fr = new FileReader();
        fr.onload = function () { ok(String(fr.result)); };
        fr.onerror = function () { no(new Error('图片读取失败')); };
        fr.readAsDataURL(blob);
      });
    });
  }

  /**
   * 前台判死后，把任务交给后台接着盯
   *
   * tasks.follow 以前只在面板启动时 resume() 里被调用：前台一失败，同一个会话里
   * 就再也没人问这个任务了，用户要么重启面板，要么手动去「我的」粘 ID。
   * 这里在判死的同一时刻把它接上，出图了照样自动写回那一轮对话。
   *
   * @returns {boolean} 是否接管成功（任务已被取回/移除时返回 false）
   */
  function handOff(taskId) {
    try {
      if (global.HH && HH.tasks && HH.tasks.takeOver) return !!HH.tasks.takeOver(taskId);
    } catch (e) { /* 后台不可用就算了，用户还能手动取回 */ }
    return false;
  }

  /**
   * 一次到位：提交 → 轮询 → 把结果图全部下载成 dataURL
   *
   * @param {object} o 同 generate()
   * @param {object} cb { onTaskId(id), onProgress(status, progress) }
   * @returns {Promise<{items:string[], taskId:string, raw:object}>}
   */
  function generateTask(o, cb) {
    cb = cb || {};
    var t0 = Date.now();

    return createTask(o).catch(function (e) {
      // 提交那一行已经记了 mode/端点/张数，这里只补「为什么没成」
      logApi('error', '提交失败 用时 ' + dur(Date.now() - t0) + ' ' + (e && e.message));
      throw e;
    }).then(function (sub) {
      // 服务端没开异步、直接给了图：退化成同步结果
      if (!sub.taskId) {
        logApi('info', '服务端未走异步，直接返回图片 ' + (sub.items || []).length +
          ' 张 用时 ' + dur(Date.now() - t0));
        return { items: sub.items || [], taskId: '', raw: sub.raw };
      }

      if (cb.onTaskId) cb.onTaskId(sub.taskId);
      if (cb.onProgress) cb.onProgress(sub.status, sub.progress);

      var lastStatus = '';
      var failRun = 0;              // 连续查询失败次数，成功一次就清零

      /** 睡一觉再问：上一轮问失败了就按退避表拉长间隔 */
      function nap() {
        var ms = failRun ? U.pollBackoff(failRun) : POLL_MS;
        return new Promise(function (r) { setTimeout(r, ms); });
      }

      function loop() {
        if (Date.now() - t0 > TASK_MAX_MS) {
          var err = new Error('等待超过 15 分钟仍未完成');
          err.taskId = sub.taskId;
          // taskId 一定要留在日志里：它是断点续取的凭据，丢了只能重跑重扣钱
          // 光把 ID 丢进日志等于给了钥匙不给门牌号 —— 必须指明去哪儿用
          logApi('error', '超时 用时 ' + dur(Date.now() - t0) + ' taskId=' + sub.taskId +
            '（到「我的 → 任务取回」填这个 ID 取回，别重跑）' +
            (handOff(sub.taskId) ? '｜已转后台继续等，出图会自动回来' : ''));
          throw err;
        }
        return nap().then(function () {
          return pollTask(sub.taskId).then(function (st) {
            // 抖完恢复了：记一行，让日志能看出中间断过而不是一直顺畅
            if (failRun) {
              logApi('info', '查询恢复 taskId=' + sub.taskId + '（此前连续失败 ' + failRun + ' 次）');
              failRun = 0;
            }
            return st;
          }, function (e) {
            failRun++;
            var why = String((e && e.message) || e || '未知原因');

            if (failRun >= POLL_FAIL_MAX) {
              var dead = new Error('连续 ' + failRun + ' 次查询失败：' + why);
              dead.taskId = sub.taskId;
              logApi('error', '查询连续失败 ' + failRun + ' 次 taskId=' + sub.taskId +
                ' 用时 ' + dur(Date.now() - t0) + ' 最后原因=' + why +
                (handOff(sub.taskId) ? '｜已转后台继续等，出图会自动回来' : ''));
              throw dead;
            }

            // 单次查询失败不是任务失败：服务端还在跑，钱已经扣了
            logApi('warn', '查询失败 taskId=' + sub.taskId + ' 第 ' + failRun + '/' +
              POLL_FAIL_MAX + ' 次 ' + why + '，' +
              Math.round(U.pollBackoff(failRun) / 1000) + 's 后重试');
            return null;
          }).then(function (st) {
            if (!st) return loop();

            if (cb.onProgress) cb.onProgress(st.status, st.progress);

            // 只在状态跃变时记：稳态 6 秒一次，15 分钟能刷 150 行，
            // 全记会把关键那几行淹掉，只有 queued→processing→completed 才值一行
            if (st.status !== lastStatus) {
              logApi('info', 'poll ' + sub.taskId + ' ' +
                (lastStatus ? lastStatus + '→' + st.status : st.status) +
                (st.progress ? ' ' + st.progress : ''));
              lastStatus = st.status;
            }

            if (st.failed) {
              var e = new Error(st.error || '任务失败');
              e.taskId = sub.taskId;
              logApi('error', '失败 taskId=' + sub.taskId + ' 用时 ' + dur(Date.now() - t0) +
                ' 状态=' + st.status + ' 原因=' + String(st.error || '未知'));
              throw e;
            }
            if (st.done) return st;
            return loop();
          });
        });
      }

      return loop().then(function (st) {
        if (!st.urls.length) {
          var e = new Error(errorTextOf(st.raw) || '任务已完成，但返回里没有图片地址');
          e.taskId = sub.taskId;
          logApi('error', '完成但无图 taskId=' + sub.taskId + ' 用时 ' + dur(Date.now() - t0));
          throw e;
        }
        logApi('info', '完成 taskId=' + sub.taskId + ' 用时 ' + dur(Date.now() - t0) +
          ' 图片 ' + st.urls.length + ' 张');
        return Promise.all(st.urls.map(function (u) {
          // 下载失败就退回直链，卡片还能显示。但只退「看起来像图片」的，
          // 免得把错误文案当图片源塞进 <img>（那会渲染成一张破图）
          return urlToDataUrl(u).catch(function () { return looksLikeImage(u) ? u : ''; });
        })).then(function (items) {
          items = items.filter(Boolean);
          if (!items.length) {
            var e2 = new Error('图片下载失败，服务端返回的可能不是图片');
            e2.taskId = sub.taskId;
            logApi('error', '下载失败 taskId=' + sub.taskId + ' 用时 ' + dur(Date.now() - t0));
            throw e2;
          }
          return { items: items, taskId: sub.taskId, raw: st.raw };
        });
      });
    });
  }

  HH.api = {
    isConfigured: isConfigured,
    POLL_MS: POLL_MS,
    POLL_FAIL_MAX: POLL_FAIL_MAX,
    createTask: createTask,
    pollTask: pollTask,
    generateTask: generateTask,
    urlToDataUrl: urlToDataUrl,
    normalizeBase: normalizeBase,
    hasNode: hasNode,
    modelsUrls: modelsUrls,
    testConnection: testConnection,
    fetchModels: fetchModels,
    generate: generate,
    ratioToSize: ratioToSize,
    // 生图质量档位（选项由模型决定，见 qualityOptions 注释）
    qualityOptions: qualityOptions,
    normalizeQuality: normalizeQuality,
    QUALITY_LABEL: QUALITY_LABEL,
    // 暴露给高级用户改协议
    buildCustomPayload: buildCustomPayload,
    buildOpenAIPayload: buildOpenAIPayload,
    parseResponse: parseResponse,
    errorTextOf: errorTextOf,
    looksLikeImage: looksLikeImage,
    // 图生图：有图必须走 edits，塞进 generations 会被静默丢弃（见 submitGenRequest 注释）
    editsUrlFor: editsUrlFor,
    // 服务端亲口说的参考图上限（0 = 还没被纠正过）。页面据此收敛可选张数，
    // 别拿我们实测出来的 9 去赌别人家的规则。
    refLimit: function () { return refLimitSeen; },
    parseRefLimit: parseRefLimit,
    buildEditsForm: buildEditsForm,
    dataUrlToBlob: dataUrlToBlob,
    mockImage: mockImage
  };

})(window);
