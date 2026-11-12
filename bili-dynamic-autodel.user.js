// ==UserScript==
// @name         Bili.Dynamic.AutoDel
// @namespace    https://github.com/labmanH2/bilibili-dynamic-del-pro
// @version      2026.11.01
// @description  删除B站转发的已开奖动态和源动态已被删除的动态；先完整扫描再串行删除，降低风控风险。
// @author       labmanH2 and monSteRhhe
// @match        http*://*.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_info
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @noframes
// @require      https://unpkg.com/axios@1.7.9/dist/axios.min.js
// ==/UserScript==
/* globals axios */

(function () {
    'use strict';

    const SCRIPT_NAME = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.name)
        ? GM_info.script.name
        : 'Bili.Dynamic.AutoDel';
    const SCRIPT_ICON = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.icon)
        ? GM_info.script.icon
        : 'https://www.bilibili.com/favicon.ico';

    const API = {
        feed: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
        lottery: 'https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?business_type=4&business_id=',
        remove: 'https://api.bilibili.com/x/dynamic/feed/operate/remove',
        relation: 'https://api.bilibili.com/x/relation/modify',
    };

    // B 站常见的风控返回码；HTTP 412/429 也算风控。
    const RISK_CODES = new Set([-352, -412, -509, -799]);
    const MAX_PAGES = 500;
    const RISK_RETRIES = 2;
    const RISK_WAITS = [45000, 90000];
    const LOCK_TTL = 30 * 60 * 1000;

    const DEFAULTS = {
        'set-unfollow': false,
        'delay-min': 1000,
        'delay-max': 2000,
        'delete-delay-min': 2500,
        'delete-delay-max': 4000,
        'cooldown-minutes': 10,
        'show-progress': true,
        'show-notification': false,
    };

    class AbortError extends Error {
        constructor(message) {
            super(message || '已停止');
            this.name = 'AbortError';
        }
    }

    class RiskControlError extends Error {
        constructor(message, label) {
            super(message);
            this.name = 'RiskControlError';
            this.label = label || '';
        }
    }

    class FatalError extends Error {
        constructor(message) {
            super(message);
            this.name = 'FatalError';
        }
    }

    const state = {
        running: false,
        stopRequested: false,
        phase: 'idle',
        status: '',
        page: 0,
        scanned: 0,
        checked: 0,
        candidates: 0,
        deleted: 0,
        failed: 0,
        unfollowed: 0,
        unfollowFailed: 0,
        riskHits: 0,
        totalToDelete: 0,
        startedAt: 0,
        lastRequestAt: 0,
    };

    let panel = null;
    let panelLog = [];

    function initializeSettings() {
        for (const key of Object.keys(DEFAULTS)) {
            if (GM_getValue(key) === undefined) {
                GM_setValue(key, DEFAULTS[key]);
            }
        }
        if (!Array.isArray(GM_getValue('unfollow-list'))) {
            GM_setValue('unfollow-list', []);
        }
        if (GM_getValue('last-run-at') === undefined) {
            GM_setValue('last-run-at', 0);
        }
        if (GM_getValue('run-lock') === undefined) {
            GM_setValue('run-lock', 0);
        }
    }

    function getSetting(key, fallback) {
        const value = GM_getValue(key);
        if (value === undefined || value === null) {
            return fallback !== undefined ? fallback : DEFAULTS[key];
        }
        return value;
    }

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) {
            return min;
        }
        return Math.min(max, Math.max(min, value));
    }

    function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return hours + ' 小时 ' + minutes + ' 分';
        }
        if (minutes > 0) {
            return minutes + ' 分 ' + seconds + ' 秒';
        }
        return seconds + ' 秒';
    }

    function getBeforeDate(days) {
        const date = new Date();
        date.setDate(date.getDate() - Number(days));
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        return year + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
    }

    function timestampToDate(timestamp) {
        const date = new Date(Number(timestamp) * 1000);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        return year + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
    }

    function getCookie(name) {
        const target = name + '=';
        const parts = String(document.cookie || '').split(';');
        for (let part of parts) {
            part = part.trim();
            if (part.indexOf(target) === 0) {
                const value = part.slice(target.length);
                try {
                    return decodeURIComponent(value);
                } catch (error) {
                    return value;
                }
            }
        }
        return '';
    }

    function log(message, level) {
        const prefix = '[' + SCRIPT_NAME + ']';
        if (level === 'error') {
            console.error(prefix, message);
        } else if (level === 'warn') {
            console.warn(prefix, message);
        } else {
            console.log(prefix, message);
        }
        appendLog(message);
    }

    function notify(message) {
        if (!getSetting('show-notification', false)) {
            return;
        }
        if (typeof GM_notification !== 'function') {
            return;
        }
        try {
            GM_notification({
                text: message,
                title: SCRIPT_NAME,
                image: SCRIPT_ICON,
                timeout: 5000,
            });
        } catch (error) {
            // 通知失败不应影响任务
        }
    }

    function sleep(ms) {
        return new Promise(function (resolve, reject) {
            const started = Date.now();
            const tick = function () {
                if (state.stopRequested) {
                    reject(new AbortError());
                    return;
                }
                const left = ms - (Date.now() - started);
                if (left <= 0) {
                    resolve();
                    return;
                }
                setTimeout(tick, Math.min(500, left));
            };
            tick();
        });
    }

    function checkStop() {
        if (state.stopRequested) {
            throw new AbortError();
        }
    }

    function refreshLock() {
        if (state.running) {
            GM_setValue('run-lock', Date.now());
        }
    }

    async function pace(kind) {
        const isWrite = kind === 'write';
        const minKey = isWrite ? 'delete-delay-min' : 'delay-min';
        const maxKey = isWrite ? 'delete-delay-max' : 'delay-max';
        const min = clamp(Number(getSetting(minKey)), 300, 60000);
        const max = clamp(Number(getSetting(maxKey)), min, 120000);
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        const wait = state.lastRequestAt + delay - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        state.lastRequestAt = Date.now();
    }

    /**
     * 所有 API 请求都从这里走：
     * 1. 串行排队，请求之间强制随机间隔；
     * 2. 遇到 412 / -352 等风控时暂停后重试；
     * 3. 连续风控则停止整个任务，避免越陷越深。
     */
    async function apiRequest(config, label, kind) {
        let riskTries = 0;
        let netTries = 0;

        for (;;) {
            checkStop();
            await pace(kind || 'read');

            let response;
            try {
                response = await axios(Object.assign({
                    timeout: 20000,
                    withCredentials: true,
                }, config));
            } catch (error) {
                const status = error && error.response && error.response.status;
                if (status === 412 || status === 429) {
                    // 交给下面的风控处理
                } else {
                    netTries++;
                    if (netTries <= 2) {
                        const wait = 2000 * netTries;
                        log(label + ' 请求失败：' + (error && error.message ? error.message : error) + '，' + Math.round(wait / 1000) + ' 秒后重试…', 'warn');
                        await sleep(wait);
                        continue;
                    }
                    throw error;
                }
            }

            if (response) {
                const body = response.data;
                if (typeof body === 'string' && /captcha|风控|验证码|出错啦/i.test(body)) {
                    // 有些风控会以 HTTP 200 返回验证码 HTML
                } else if (!(body && RISK_CODES.has(Number(body.code)))) {
                    return body;
                }
            }

            riskTries++;
            state.riskHits++;
            if (riskTries > RISK_RETRIES) {
                throw new RiskControlError(label + ' 连续触发B站风控，已停止本次任务。', label);
            }

            const wait = RISK_WAITS[Math.min(riskTries - 1, RISK_WAITS.length - 1)];
            log('[风控] ' + label + ' 被B站拦截，暂停 ' + Math.round(wait / 1000) + ' 秒后重试（' + riskTries + '/' + RISK_RETRIES + '）…', 'warn');
            setStatus('触发B站风控，暂停 ' + Math.round(wait / 1000) + ' 秒…');
            await sleep(wait);
        }
    }

    function buildFeedUrl(duid, offset) {
        return API.feed + '?offset=' + encodeURIComponent(offset || '') + '&host_mid=' + encodeURIComponent(duid);
    }

    /**
     * 第一阶段：只读扫描，把当前能看到的动态全部收集下来。
     * 删除期间不再翻页，避免“边删边翻页”造成 offset 位移、漏掉动态。
     */
    async function scanAll(duid) {
        const items = [];
        const seenItemIds = new Set();
        const seenOffsets = new Set();
        let offset = '';
        let page = 0;

        state.phase = 'scan';
        for (;;) {
            checkStop();
            refreshLock();
            page++;
            state.page = page;
            setStatus('扫描第 ' + page + ' 页…');
            updatePanel();

            const body = await apiRequest({ url: buildFeedUrl(duid, offset) }, '动态列表');
            if (!body || String(body.code) !== '0') {
                const code = body && body.code;
                const message = body && body.message ? body.message : '';
                throw new Error('动态列表接口返回 code=' + code + (message ? '：' + message : ''));
            }

            const data = body.data || {};
            const list = Array.isArray(data.items) ? data.items : [];
            for (const item of list) {
                if (!item || !item.id_str || seenItemIds.has(item.id_str)) {
                    continue;
                }
                seenItemIds.add(item.id_str);
                items.push(item);
            }
            state.scanned = items.length;
            updatePanel();

            const nextOffset = data.offset === undefined || data.offset === null ? '' : String(data.offset);
            if (data.has_more === false || nextOffset === '' || nextOffset === offset || seenOffsets.has(nextOffset)) {
                break;
            }
            seenOffsets.add(nextOffset);
            offset = nextOffset;

            if (page >= MAX_PAGES) {
                log('已达到 ' + MAX_PAGES + ' 页安全上限，停止继续翻页；如仍有动态，请稍后分次处理。', 'warn');
                break;
            }
        }

        log('扫描完成：共 ' + page + ' 页、' + items.length + ' 条动态。');
        return items;
    }

    function getAuthor(orig) {
        const author = (orig && orig.modules && orig.modules.module_author) || {};
        return {
            mid: author.mid,
            name: typeof author.name === 'string' ? author.name : '',
            following: Boolean(author.following),
        };
    }

    function isMissingOrig(orig) {
        return !orig
            || orig.id_str === null
            || orig.id_str === undefined
            || orig.id_str === ''
            || String(orig.id_str) === '0';
    }

    function getOrigPubTs(orig, item) {
        const origAuthor = orig && orig.modules && orig.modules.module_author;
        if (origAuthor && origAuthor.pub_ts) {
            return Number(origAuthor.pub_ts);
        }
        const itemAuthor = item && item.modules && item.modules.module_author;
        if (itemAuthor && itemAuthor.pub_ts) {
            return Number(itemAuthor.pub_ts);
        }
        return 0;
    }

    function parseLotteryStatus(body) {
        if (!body) {
            return 'unknown';
        }
        const code = String(body.code);
        if (code === '0') {
            const status = body.data && body.data.status;
            if (status === undefined || status === null || status === '') {
                return 'unknown';
            }
            return String(status);
        }
        if (code === '-9999') {
            return 'none';
        }
        return 'unknown';
    }

    async function getLotteryStatus(origId, cache) {
        const key = String(origId);
        if (cache.has(key)) {
            return cache.get(key);
        }
        const body = await apiRequest({ url: API.lottery + encodeURIComponent(key) }, '抽奖状态');
        const status = parseLotteryStatus(body);
        cache.set(key, status);
        return status;
    }

    /**
     * 第二阶段：逐条判断，只记录候选，不发送删除请求。
     */
    async function evaluate(items, mode, input) {
        const candidates = [];
        const lotteryCache = new Map();
        const total = items.length;

        state.phase = 'evaluate';
        state.checked = 0;

        for (let i = 0; i < total; i++) {
            checkStop();
            if (i % 25 === 0) {
                refreshLock();
            }
            const item = items[i];
            state.checked = i + 1;

            if (i % 5 === 0 || i === total - 1) {
                setStatus('判断动态 ' + (i + 1) + '/' + total + '…');
                updatePanel();
            }

            if (!item || !item.orig) {
                continue;
            }

            const orig = item.orig;
            let reason = '';

            if (mode === 'auto') {
                if (isMissingOrig(orig)) {
                    reason = '源动态已被删除';
                } else {
                    const status = await getLotteryStatus(orig.id_str, lotteryCache);
                    if (status === '2') {
                        reason = '源动态是已开奖的互动抽奖';
                    }
                }
            } else if (mode === 'user') {
                const author = getAuthor(orig);
                const mid = author.mid === undefined || author.mid === null ? '' : String(author.mid);
                const hit = input.some(function (needle) {
                    if (!needle) {
                        return false;
                    }
                    return author.name.indexOf(needle) !== -1
                        || (mid !== '' && mid === needle);
                });
                if (hit) {
                    reason = '源动态作者匹配：' + (author.name || mid);
                }
            } else if (mode === 'days_ago') {
                const pubTs = getOrigPubTs(orig, item);
                if (pubTs > 0 && timestampToDate(pubTs) <= input.beforeDate) {
                    if (isMissingOrig(orig)) {
                        reason = '源动态已被删除，且发布时间早于 ' + input.beforeDate;
                    } else {
                        const status = await getLotteryStatus(orig.id_str, lotteryCache);
                        // 保持原脚本语义：未开奖（status=0）不删；已开奖或非抽奖动态可删。
                        if (status !== '0' && status !== 'unknown') {
                            reason = '源动态发布于 ' + timestampToDate(pubTs) + '，早于 ' + input.beforeDate;
                        }
                    }
                }
            }

            if (reason) {
                candidates.push({ item: item, orig: orig, reason: reason });
                state.candidates = candidates.length;
                if (candidates.length <= 30) {
                    log('命中 ' + item.id_str + '：' + reason);
                }
            }
        }

        log('判断完成：' + total + ' 条动态中命中 ' + candidates.length + ' 条。');
        return candidates;
    }

    async function deleteOne(item) {
        const csrf = getCookie('bili_jct');
        if (!csrf) {
            throw new FatalError('未找到 bili_jct Cookie，请确认已登录并刷新页面后重试。');
        }

        const body = await apiRequest({
            method: 'post',
            url: API.remove + '?csrf=' + encodeURIComponent(csrf),
            data: {
                dyn_id_str: String(item.id_str),
            },
        }, '删除动态', 'write');

        const code = String(body && body.code);
        if (code === '0') {
            return;
        }
        if (code === '-111') {
            throw new FatalError('CSRF 校验失败（bili_jct 可能已过期），请刷新页面后重试。');
        }
        if (code === '-101') {
            throw new FatalError('账号未登录，请重新登录后重试。');
        }
        const message = body && body.message ? '：' + body.message : '';
        throw new Error('删除接口返回 code=' + code + message);
    }

    /**
     * 第三阶段：串行删除。倒序删除（从旧到新），中途停止时优先保留较新的动态。
     */
    async function deleteCandidates(candidates) {
        const list = candidates.slice().reverse();
        state.phase = 'delete';
        state.totalToDelete = list.length;

        if (!list.length) {
            log('没有需要删除的动态。');
            return;
        }

        for (let i = 0; i < list.length; i++) {
            checkStop();
            refreshLock();
            const candidate = list[i];
            setStatus('删除 ' + (i + 1) + '/' + list.length + '：' + candidate.item.id_str);
            updatePanel();

            try {
                await deleteOne(candidate.item);
                state.deleted++;
                log('已删除 ' + candidate.item.id_str + '（' + candidate.reason + '）');

                if (getSetting('set-unfollow', false)) {
                    addUnfollowUser(candidate.orig);
                }
            } catch (error) {
                if (error && (error.name === 'AbortError'
                    || error.name === 'RiskControlError'
                    || error.name === 'FatalError')) {
                    throw error;
                }
                state.failed++;
                log('删除失败 ' + candidate.item.id_str + '：' + (error && error.message ? error.message : error), 'error');
            }
            updatePanel();
        }
    }

    function getUnfollowList() {
        const raw = GM_getValue('unfollow-list');
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw.map(function (value) {
            return String(value);
        }).filter(Boolean);
    }

    function addUnfollowUser(orig) {
        const author = getAuthor(orig);
        if (!author.mid || !author.following) {
            return;
        }
        const uid = String(author.mid);
        const list = getUnfollowList();
        if (list.indexOf(uid) === -1) {
            list.push(uid);
            GM_setValue('unfollow-list', list);
            log('已加入取关列表：' + (author.name || uid) + '（UID ' + uid + '）');
        }
    }

    async function unfollowAll() {
        const list = getUnfollowList();
        if (!list.length) {
            return;
        }

        state.phase = 'unfollow';
        const remaining = [];

        for (let i = 0; i < list.length; i++) {
            checkStop();
            refreshLock();
            const uid = list[i];
            setStatus('取关 ' + (i + 1) + '/' + list.length + '：UID ' + uid);
            updatePanel();

            try {
                const csrf = getCookie('bili_jct');
                if (!csrf) {
                    throw new FatalError('未找到 bili_jct Cookie，无法取关。');
                }

                const body = await apiRequest({
                    method: 'post',
                    url: API.relation,
                    data: {
                        fid: uid,
                        act: 2,
                        re_src: 11,
                        spmid: '333.999.0.0',
                        csrf: csrf,
                    },
                }, '取关', 'write');

                if (body && String(body.code) === '0') {
                    state.unfollowed++;
                    log('已取关 UID ' + uid);
                } else {
                    state.unfollowFailed++;
                    remaining.push(uid);
                    log('取关失败 UID ' + uid + '：code=' + (body && body.code), 'warn');
                }
            } catch (error) {
                if (error && (error.name === 'AbortError'
                    || error.name === 'RiskControlError'
                    || error.name === 'FatalError')) {
                    // 保留当前及之后未处理的 UID，下次运行继续
                    remaining.push.apply(remaining, list.slice(i));
                    GM_setValue('unfollow-list', remaining);
                    throw error;
                }
                state.unfollowFailed++;
                remaining.push(uid);
                log('取关失败 UID ' + uid + '：' + (error && error.message ? error.message : error), 'warn');
            }
        }

        GM_setValue('unfollow-list', remaining);
    }

    function describeMode(mode, input) {
        if (mode === 'auto') {
            return '自动判断（已开奖 / 源动态已删除）';
        }
        if (mode === 'scan') {
            return '仅扫描，不删除';
        }
        if (mode === 'user') {
            return '指定用户：' + input.join(', ');
        }
        if (mode === 'days_ago') {
            return '删除源动态发布于 ' + input.beforeDate + ' 及之前的转发';
        }
        return mode;
    }

    function buildSummary() {
        const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
        let text = '扫描 ' + state.scanned + ' 条，命中 ' + state.candidates + ' 条，删除 ' + state.deleted + ' 条，失败 ' + state.failed + ' 条';
        if (state.unfollowed || state.unfollowFailed) {
            text += '，取关 ' + state.unfollowed + ' 个';
            if (state.unfollowFailed) {
                text += '（失败 ' + state.unfollowFailed + ' 个）';
            }
        }
        if (state.riskHits) {
            text += '，风控暂停 ' + state.riskHits + ' 次';
        }
        text += '，用时 ' + formatDuration(elapsed);
        return text;
    }

    function resetState() {
        state.stopRequested = false;
        state.phase = 'init';
        state.status = '';
        state.page = 0;
        state.scanned = 0;
        state.checked = 0;
        state.candidates = 0;
        state.deleted = 0;
        state.failed = 0;
        state.unfollowed = 0;
        state.unfollowFailed = 0;
        state.riskHits = 0;
        state.totalToDelete = 0;
        state.startedAt = 0;
        state.lastRequestAt = 0;
        panelLog = [];
        if (panel && panel.parentNode) {
            panel.parentNode.removeChild(panel);
        }
        panel = null;
    }

    function start(mode) {
        if (state.running) {
            alert('已有任务正在运行，请等待结束或先停止。');
            return Promise.resolve();
        }

        const duid = getCookie('DedeUserID');
        if (!duid) {
            alert('未检测到登录状态（DedeUserID Cookie 不存在）。请先登录B站并刷新页面。');
            return Promise.resolve();
        }

        if (typeof axios === 'undefined' || !axios) {
            alert('axios 依赖加载失败。请检查脚本管理器中 @require 的加载状态，或更换可访问 unpkg 的网络后重试。');
            return Promise.resolve();
        }

        let input = null;

        if (mode === 'user') {
            const raw = prompt('请输入想要删除的用户名或 UID（多个用英文逗号分隔）：');
            if (raw === null) {
                return Promise.resolve();
            }
            const needles = raw.split(',').map(function (value) {
                return value.trim();
            }).filter(Boolean);
            if (!needles.length) {
                alert('没有输入内容。');
                return Promise.resolve();
            }
            input = needles;
        } else if (mode === 'days_ago') {
            const raw = prompt('请输入想要删除多少天前的动态（非负整数，例如 30）：');
            if (raw === null) {
                return Promise.resolve();
            }
            const days = Number(raw.trim());
            if (!Number.isInteger(days) || days < 0) {
                alert('请输入非负整数。');
                return Promise.resolve();
            }
            input = { days: days, beforeDate: getBeforeDate(days) };
        } else if (mode !== 'auto' && mode !== 'scan') {
            alert('未知模式：' + mode);
            return Promise.resolve();
        }

        const lock = Number(getSetting('run-lock', 0)) || 0;
        if (lock && Date.now() - lock < LOCK_TTL) {
            alert('检测到另一个任务正在运行（或上次异常退出未释放锁）。\n请等待其结束，或在菜单中执行“清除运行锁/冷却”。');
            return Promise.resolve();
        }

        const lastRun = Number(getSetting('last-run-at', 0)) || 0;
        const cooldownMinutes = clamp(Number(getSetting('cooldown-minutes', 10)), 0, 1440);
        const cooldownMs = cooldownMinutes * 60000;
        if (lastRun && Date.now() - lastRun < cooldownMs) {
            const remain = Math.ceil((cooldownMs - (Date.now() - lastRun)) / 60000);
            const ok = confirm('距离上次运行不到 ' + cooldownMinutes + ' 分钟（约剩 ' + remain + ' 分钟）。\n'
                + '短时间内反复运行容易触发B站风控，导致个人动态暂时不显示。\n'
                + '仍要现在运行吗？');
            if (!ok) {
                return Promise.resolve();
            }
        }

        resetState();
        state.running = true;
        state.startedAt = Date.now();
        state.phase = 'init';
        GM_setValue('run-lock', Date.now());
        GM_setValue('last-run-at', Date.now());

        return run(mode, input, duid);
    }

    async function run(mode, input, duid) {
        try {
            if (getSetting('show-progress', true)) {
                createPanel();
            }
            log('开始任务：' + describeMode(mode, input));
            setStatus('准备扫描…');

            const items = await scanAll(duid);
            const evalMode = mode === 'scan' ? 'auto' : mode;
            const candidates = await evaluate(items, evalMode, input);
            state.candidates = candidates.length;

            if (mode === 'scan') {
                log('仅扫描模式：不会删除任何动态。候选如下（最多显示 30 条）：');
                candidates.slice(0, 30).forEach(function (candidate) {
                    log('  ' + candidate.item.id_str + '  ' + candidate.reason);
                });
                if (candidates.length > 30) {
                    log('  …另有 ' + (candidates.length - 30) + ' 条候选。');
                }
            } else {
                await deleteCandidates(candidates);
                if (getSetting('set-unfollow', false)) {
                    await unfollowAll();
                }
            }

            finishPanel('ok', '完成：' + buildSummary());
        } catch (error) {
            if (error && error.name === 'AbortError') {
                finishPanel('warn', '已停止：' + buildSummary());
            } else if (error && error.name === 'RiskControlError') {
                finishPanel('error', error.message + ' 请等待 30–60 分钟再试；如页面出现验证码，请先完成验证。期间不要重复运行。' + buildSummary());
            } else if (error && error.name === 'FatalError') {
                finishPanel('error', error.message + ' ' + buildSummary());
            } else {
                console.error('[' + SCRIPT_NAME + ']', error);
                finishPanel('error', '任务失败：' + (error && error.message ? error.message : error) + ' ' + buildSummary());
            }
        } finally {
            state.running = false;
            state.stopRequested = false;
            GM_setValue('run-lock', 0);
        }
    }

    function requestStop() {
        if (!state.running) {
            alert('当前没有正在运行的任务。');
            return;
        }
        state.stopRequested = true;
        setStatus('正在停止，请稍候…');
        log('已请求停止；当前请求结束后会停下。', 'warn');
    }

    function clearLockAndCooldown() {
        if (state.running) {
            alert('当前有任务正在运行，不能清除运行锁。\n请先等待任务结束或点击“停止当前任务”。');
            return;
        }
        if (!confirm('确定清除运行锁和上次运行时间吗？\n仅在任务异常退出、无法再次启动时使用。')) {
            return;
        }
        GM_setValue('run-lock', 0);
        GM_setValue('last-run-at', 0);
        alert('已清除运行锁和冷却记录。');
    }

    function showPanel() {
        if (panel) {
            panel.style.display = 'block';
            return;
        }
        alert('当前没有进度面板。任务运行时才会创建。');
    }

    function createPanel() {
        if (panel) {
            return;
        }

        panel = document.createElement('div');
        panel.className = 'bd-panel';
        panel.innerHTML = `
            <div class="bd-head">
                <span>B站动态清理</span>
                <button type="button" class="bd-close" title="隐藏面板">×</button>
            </div>
            <div class="bd-body">
                <div class="bd-status">准备中…</div>
                <div class="bd-stats">
                    <span>扫描 <b data-k="scanned">0</b></span>
                    <span>命中 <b data-k="candidates">0</b></span>
                    <span>删除 <b data-k="deleted">0</b></span>
                    <span>失败 <b data-k="failed">0</b></span>
                </div>
                <div class="bd-bar"><i></i></div>
                <div class="bd-log"></div>
                <div class="bd-foot">
                    <span class="bd-time">0:00</span>
                    <button type="button" class="bd-stop">停止</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        const closeButton = panel.querySelector('.bd-close');
        if (closeButton) {
            closeButton.addEventListener('click', function () {
                panel.style.display = 'none';
            });
        }

        const stopButton = panel.querySelector('.bd-stop');
        if (stopButton) {
            stopButton.addEventListener('click', requestStop);
        }

        updatePanel();
    }

    function setPanelText(selector, text) {
        if (!panel) {
            return;
        }
        const element = panel.querySelector(selector);
        if (element) {
            element.textContent = String(text);
        }
    }

    function setStatus(message) {
        state.status = message;
        setPanelText('.bd-status', message);
    }

    function appendLog(message) {
        panelLog.push('[' + new Date().toLocaleTimeString() + '] ' + message);
        if (panelLog.length > 50) {
            panelLog.shift();
        }
        if (panel) {
            const logElement = panel.querySelector('.bd-log');
            if (logElement) {
                logElement.textContent = panelLog.slice(-6).join('\n');
            }
        }
    }

    function updatePanel() {
        if (!panel) {
            return;
        }

        setPanelText('[data-k="scanned"]', state.scanned);
        setPanelText('[data-k="candidates"]', state.candidates);
        setPanelText('[data-k="deleted"]', state.deleted);
        setPanelText('[data-k="failed"]', state.failed);
        setPanelText('.bd-status', state.status);
        setPanelText('.bd-time', formatDuration(state.startedAt ? Date.now() - state.startedAt : 0));

        const bar = panel.querySelector('.bd-bar > i');
        if (bar) {
            let percent = 0;
            if (state.phase === 'delete' && state.totalToDelete > 0) {
                percent = state.deleted / state.totalToDelete * 100;
            } else if (state.phase === 'evaluate' && state.scanned > 0) {
                percent = state.checked / state.scanned * 100;
            } else if (state.phase === 'done') {
                percent = 100;
            }
            bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
        }

        const logElement = panel.querySelector('.bd-log');
        if (logElement) {
            logElement.textContent = panelLog.slice(-6).join('\n');
        }
    }

    function finishPanel(kind, message) {
        state.phase = 'done';
        setStatus(message);
        if (panel) {
            if (kind === 'error') {
                panel.classList.add('bd-error');
            } else if (kind === 'warn') {
                panel.classList.add('bd-warn');
            } else {
                panel.classList.add('bd-ok');
            }
            const stopButton = panel.querySelector('.bd-stop');
            if (stopButton) {
                stopButton.style.display = 'none';
            }
        }
        log(message, kind === 'error' ? 'error' : 'info');
        notify(message);
        updatePanel();
    }

    function openSettings() {
        if (document.querySelector('.bd-settings-mask')) {
            return;
        }

        const mask = document.createElement('div');
        mask.className = 'bd-settings-mask';
        mask.innerHTML = `
            <div class="bd-settings">
                <div class="bd-settings-head">设置</div>
                <div class="bd-settings-body">
                    <label class="bd-row">
                        <span>启用取关功能</span>
                        <input type="checkbox" id="bd-set-unfollow">
                    </label>
                    <label class="bd-row">
                        <span>显示进度面板</span>
                        <input type="checkbox" id="bd-show-progress">
                    </label>
                    <label class="bd-row">
                        <span>弹出系统通知</span>
                        <input type="checkbox" id="bd-show-notification">
                    </label>
                    <div class="bd-group-title">请求间隔（毫秒）</div>
                    <div class="bd-row">
                        <span>读取最小 / 最大</span>
                        <span class="bd-number-pair">
                            <input type="number" id="bd-delay-min" min="500" step="100">
                            /
                            <input type="number" id="bd-delay-max" min="500" step="100">
                        </span>
                    </div>
                    <div class="bd-row">
                        <span>删除最小 / 最大</span>
                        <span class="bd-number-pair">
                            <input type="number" id="bd-delete-delay-min" min="500" step="100">
                            /
                            <input type="number" id="bd-delete-delay-max" min="500" step="100">
                        </span>
                    </div>
                    <div class="bd-row">
                        <span>两次运行冷却（分钟）</span>
                        <input type="number" id="bd-cooldown-minutes" min="0" step="1">
                    </div>
                    <div class="bd-hint">
                        读取间隔建议不低于 800ms，删除间隔建议不低于 1500ms。数值越大越安全，但耗时更长。
                    </div>
                </div>
                <div class="bd-settings-foot">
                    <button type="button" class="bd-settings-reset">恢复默认</button>
                    <span>
                        <button type="button" class="bd-settings-close">取消</button>
                        <button type="button" class="bd-settings-save bd-primary">保存</button>
                    </span>
                </div>
            </div>
        `;
        document.body.appendChild(mask);

        fillSettings(mask, false);

        const close = function () {
            if (mask.parentNode) {
                mask.parentNode.removeChild(mask);
            }
        };

        const closeButton = mask.querySelector('.bd-settings-close');
        if (closeButton) {
            closeButton.addEventListener('click', close);
        }

        const saveButton = mask.querySelector('.bd-settings-save');
        if (saveButton) {
            saveButton.addEventListener('click', function () {
                saveSettings(mask);
                close();
            });
        }

        const resetButton = mask.querySelector('.bd-settings-reset');
        if (resetButton) {
            resetButton.addEventListener('click', function () {
                fillSettings(mask, true);
            });
        }

        mask.addEventListener('click', function (event) {
            if (event.target === mask) {
                close();
            }
        });
    }

    function fillSettings(mask, useDefaults) {
        const read = function (key) {
            return useDefaults ? DEFAULTS[key] : getSetting(key);
        };
        const setCheckbox = function (id, value) {
            const element = mask.querySelector('#' + id);
            if (element) {
                element.checked = Boolean(value);
            }
        };
        const setValue = function (id, value) {
            const element = mask.querySelector('#' + id);
            if (element) {
                element.value = String(value);
            }
        };

        setCheckbox('bd-set-unfollow', read('set-unfollow'));
        setCheckbox('bd-show-progress', read('show-progress'));
        setCheckbox('bd-show-notification', read('show-notification'));
        setValue('bd-delay-min', read('delay-min'));
        setValue('bd-delay-max', read('delay-max'));
        setValue('bd-delete-delay-min', read('delete-delay-min'));
        setValue('bd-delete-delay-max', read('delete-delay-max'));
        setValue('bd-cooldown-minutes', read('cooldown-minutes'));
    }

    function saveSettings(mask) {
        const readNumber = function (id, fallback) {
            const element = mask.querySelector('#' + id);
            const value = Number(element && element.value);
            return Number.isFinite(value) ? value : fallback;
        };
        const readCheckbox = function (id) {
            const element = mask.querySelector('#' + id);
            return Boolean(element && element.checked);
        };

        const delayMin = clamp(readNumber('bd-delay-min', DEFAULTS['delay-min']), 500, 30000);
        const delayMax = clamp(readNumber('bd-delay-max', DEFAULTS['delay-max']), delayMin, 60000);
        const deleteDelayMin = clamp(readNumber('bd-delete-delay-min', DEFAULTS['delete-delay-min']), 500, 60000);
        const deleteDelayMax = clamp(readNumber('bd-delete-delay-max', DEFAULTS['delete-delay-max']), deleteDelayMin, 120000);
        const cooldownMinutes = clamp(readNumber('bd-cooldown-minutes', DEFAULTS['cooldown-minutes']), 0, 1440);

        GM_setValue('set-unfollow', readCheckbox('bd-set-unfollow'));
        GM_setValue('show-progress', readCheckbox('bd-show-progress'));
        GM_setValue('show-notification', readCheckbox('bd-show-notification'));
        GM_setValue('delay-min', delayMin);
        GM_setValue('delay-max', delayMax);
        GM_setValue('delete-delay-min', deleteDelayMin);
        GM_setValue('delete-delay-max', deleteDelayMax);
        GM_setValue('cooldown-minutes', cooldownMinutes);

        log('设置已保存。');
    }

    function addStyle(css) {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
            return;
        }
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    const STYLE = `
        .bd-panel {
            position: fixed;
            right: 18px;
            bottom: 18px;
            z-index: 2147483647;
            width: 320px;
            background: #ffffff;
            color: #18191c;
            border: 1px solid #e3e5e7;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
            overflow: hidden;
            font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .bd-panel .bd-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: #00a1d6;
            color: #ffffff;
            font-weight: 600;
        }
        .bd-panel .bd-head button {
            border: 0;
            background: transparent;
            color: #ffffff;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 0 2px;
        }
        .bd-panel .bd-body {
            padding: 10px 12px 12px;
        }
        .bd-panel .bd-status {
            min-height: 20px;
            margin-bottom: 8px;
            word-break: break-all;
        }
        .bd-panel .bd-stats {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 8px;
            color: #61666d;
            font-size: 12px;
        }
        .bd-panel .bd-stats b {
            color: #00a1d6;
            font-size: 14px;
        }
        .bd-panel .bd-bar {
            height: 5px;
            margin-bottom: 8px;
            background: #e3e5e7;
            border-radius: 3px;
            overflow: hidden;
        }
        .bd-panel .bd-bar i {
            display: block;
            width: 0;
            height: 100%;
            background: linear-gradient(90deg, #00a1d6, #23d5d5);
            transition: width 0.3s ease;
        }
        .bd-panel .bd-log {
            height: 54px;
            margin-bottom: 8px;
            padding: 6px 8px;
            overflow: auto;
            background: #f6f7f8;
            border-radius: 6px;
            color: #61666d;
            font-size: 11px;
            line-height: 1.45;
            white-space: pre-line;
        }
        .bd-panel .bd-foot {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .bd-panel .bd-time {
            color: #9499a0;
            font-size: 12px;
        }
        .bd-panel .bd-stop {
            border: 0;
            border-radius: 6px;
            padding: 5px 14px;
            background: #f56c6c;
            color: #ffffff;
            cursor: pointer;
        }
        .bd-panel .bd-stop:hover {
            background: #e04b4b;
        }
        .bd-panel.bd-ok {
            border-color: #00a1d6;
        }
        .bd-panel.bd-error {
            border-color: #f56c6c;
        }
        .bd-panel.bd-error .bd-head {
            background: #f56c6c;
        }
        .bd-panel.bd-warn {
            border-color: #e6a23c;
        }
        .bd-panel.bd-warn .bd-head {
            background: #e6a23c;
        }
        .bd-settings-mask {
            position: fixed;
            top: 0;
            right: 0;
            bottom: 0;
            left: 0;
            z-index: 2147483646;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.45);
        }
        .bd-settings {
            width: 430px;
            max-width: calc(100vw - 32px);
            background: #ffffff;
            color: #18191c;
            border-radius: 12px;
            box-shadow: 0 8px 40px rgba(0, 0, 0, 0.25);
            overflow: hidden;
            font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .bd-settings .bd-settings-head {
            padding: 15px 20px;
            background: #00a1d6;
            color: #ffffff;
            font-size: 17px;
            font-weight: 600;
        }
        .bd-settings .bd-settings-body {
            padding: 16px 20px 8px;
        }
        .bd-settings .bd-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }
        .bd-settings .bd-row input[type="checkbox"] {
            width: 16px;
            height: 16px;
        }
        .bd-settings .bd-row input[type="number"] {
            width: 78px;
            height: 28px;
            padding: 0 6px;
            border: 1px solid #c9ccd0;
            border-radius: 5px;
            text-align: center;
        }
        .bd-settings .bd-number-pair {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #9499a0;
        }
        .bd-settings .bd-group-title {
            margin: 14px 0 10px;
            padding-top: 10px;
            border-top: 1px solid #e3e5e7;
            color: #61666d;
            font-size: 12px;
            font-weight: 600;
        }
        .bd-settings .bd-hint {
            margin: 4px 0 8px;
            color: #9499a0;
            font-size: 12px;
        }
        .bd-settings .bd-settings-foot {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px 16px;
        }
        .bd-settings .bd-settings-foot button {
            border: 1px solid #c9ccd0;
            border-radius: 6px;
            padding: 6px 14px;
            background: #ffffff;
            color: #18191c;
            cursor: pointer;
        }
        .bd-settings .bd-settings-foot button.bd-primary {
            border-color: #00a1d6;
            background: #00a1d6;
            color: #ffffff;
        }
    `;

    initializeSettings();
    addStyle(STYLE);

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('自动判断（已开奖/源已删除）', function () {
            return start('auto');
        });
        GM_registerMenuCommand('指定用户', function () {
            return start('user');
        });
        GM_registerMenuCommand('删除 X 天前', function () {
            return start('days_ago');
        });
        GM_registerMenuCommand('仅扫描（不删除）', function () {
            return start('scan');
        });
        GM_registerMenuCommand('停止当前任务', requestStop);
        GM_registerMenuCommand('显示进度面板', showPanel);
        GM_registerMenuCommand('打开设置', openSettings);
        GM_registerMenuCommand('清除运行锁/冷却', clearLockAndCooldown);
    }
})();
