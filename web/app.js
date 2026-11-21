/* ===================================================================
   app.js —— 界面逻辑：读输入 → 调 LoanCore.solve → 渲染结果与摊销表
   计算部分全部在 loan-core.js，这里只负责 DOM 与交互。
   =================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    principal: $('principal'),
    payment: $('payment'),
    months: $('months'),
    balloon: $('balloon'),
    calc: $('calc'),
    demo: $('demo'),
    reset: $('reset'),
    csv: $('csv'),
    error: $('error'),
    resultCard: $('resultCard'),
    tableCard: $('tableCard'),
    annual: $('annual'),
    monthly: $('monthly'),
    annualEffective: $('annualEffective'),
    totalInterest: $('totalInterest'),
    totalPayment: $('totalPayment'),
    periods: $('periods'),
    balloonOut: $('balloonOut'),
    note: $('note'),
    rows: $('rows')
  };

  var STORAGE_KEY = 'loan-calc-v1';
  var lastResult = null;

  /* ---------------- 输入读写 ---------------- */

  function readInputs() {
    return {
      principal: els.principal.value,
      payment: els.payment.value,
      months: els.months.value,
      balloon: els.balloon.value
    };
  }

  function fillInputs(values) {
    if (!values) return;
    els.principal.value = values.principal == null ? '' : values.principal;
    els.payment.value = values.payment == null ? '' : values.payment;
    els.months.value = values.months == null ? '' : values.months;
    els.balloon.value = values.balloon == null ? '' : values.balloon;
  }

  function saveInputs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(readInputs()));
    } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
  }

  function loadInputs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 渲染 ---------------- */

  function clearFieldErrors() {
    ['principal', 'payment', 'months', 'balloon'].forEach(function (k) {
      els[k].classList.remove('invalid');
    });
  }

  function showError(message, fieldKey) {
    clearFieldErrors();
    els.error.textContent = message;
    els.error.hidden = false;
    if (fieldKey && els[fieldKey]) els[fieldKey].classList.add('invalid');
    els.resultCard.hidden = true;
    els.tableCard.hidden = true;
    lastResult = null;
  }

  function render(result) {
    clearFieldErrors();
    els.error.hidden = true;

    els.annual.textContent = LoanCore.formatPercent(result.annualRateNominal, 4);
    els.monthly.textContent = LoanCore.formatPercent(result.monthlyRate, 6);
    els.annualEffective.textContent = LoanCore.formatPercent(result.annualRateEffective, 4);
    els.totalInterest.textContent = LoanCore.formatMoney(result.totalInterest) + ' 元';
    els.totalPayment.textContent = LoanCore.formatMoney(result.totalPayment) + ' 元';
    els.periods.textContent = result.input.months + ' 期';
    els.balloonOut.textContent = LoanCore.formatMoney(result.balloon) + ' 元';

    var notes = [];
    notes.push('每期还款 ' + LoanCore.formatMoney(result.input.payment) + ' 元，共 ' + result.input.months + ' 期。');
    if (result.balloon > 0) {
      notes.push('第 ' + result.input.months + ' 期结束后，还需一次性支付尾款 ' + LoanCore.formatMoney(result.balloon) + ' 元；表中末期余额即为该尾款。');
    }
    if (result.monthlyRate === 0) {
      notes.push('这套输入对应的利率正好是 0%（总还款额等于本金）。');
    }
    els.note.textContent = notes.join(' ');
    els.note.hidden = false;

    // ---- 表格 ----
    var rows = result.schedule;
    var html = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      html.push(
        '<tr>' +
          '<td>' + row.period + '</td>' +
          '<td>' + LoanCore.formatMoney(row.payment) + '</td>' +
          '<td>' + LoanCore.formatMoney(row.interest) + '</td>' +
          '<td>' + LoanCore.formatMoney(row.principal) + '</td>' +
          '<td' + (Math.abs(row.balance) < 0.005 ? ' class="zero"' : '') + '>' +
            LoanCore.formatMoney(row.balance) +
          '</td>' +
        '</tr>'
      );
    }
    if (result.balloon > 0) {
      html.push(
        '<tr class="balloon-row">' +
          '<td>尾款</td>' +
          '<td>' + LoanCore.formatMoney(result.balloon) + '</td>' +
          '<td>0.00</td>' +
          '<td>' + LoanCore.formatMoney(result.balloon) + '</td>' +
          '<td>0.00</td>' +
        '</tr>'
      );
    }
    els.rows.innerHTML = html.join('');

    lastResult = result;
    els.resultCard.hidden = false;
    els.tableCard.hidden = false;
  }

  /* ---------------- 计算 ---------------- */

  function calculate() {
    var input = readInputs();

    // 全空时不报错，静静地保持初始状态
    if (!input.principal && !input.payment && !input.months) {
      els.error.hidden = true;
      els.resultCard.hidden = true;
      els.tableCard.hidden = true;
      lastResult = null;
      return;
    }

    var result = LoanCore.solve(input);
    saveInputs();

    if (!result.ok) {
      showError(result.error.message, result.error.field);
      return;
    }
    render(result);
  }

  /* ---------------- 导出 CSV ---------------- */

  function downloadCsv() {
    if (!lastResult) return;
    var csv = LoanCore.toCsv(lastResult);
    var name = '摊销表_本金' + lastResult.input.principal + '_' + lastResult.input.months + '期.csv';
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      // 个别内嵌浏览器不支持下载，退化为提示
      showError('当前环境不支持直接下载文件，可长按表格复制内容。', null);
    }
  }

  /* ---------------- 事件 ---------------- */

  els.calc.addEventListener('click', calculate);
  els.csv.addEventListener('click', downloadCsv);

  els.demo.addEventListener('click', function () {
    fillInputs({ principal: '100000', payment: '8884.88', months: '12', balloon: '' });
    calculate();
  });

  els.reset.addEventListener('click', function () {
    fillInputs({ principal: '', payment: '', months: '', balloon: '' });
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    els.error.hidden = true;
    els.resultCard.hidden = true;
    els.tableCard.hidden = true;
    lastResult = null;
    els.principal.focus();
  });

  // 输入变化后自动重算（防抖 260ms），手机上少按一次按钮
  var timer = null;
  ['principal', 'payment', 'months', 'balloon'].forEach(function (key) {
    var el = els[key];
    el.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(calculate, 260);
    });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        el.blur();
        calculate();
      }
    });
  });

  /* ---------------- 启动 ---------------- */

  var saved = loadInputs();
  if (saved) {
    fillInputs(saved);
    calculate();
  }

  // Service Worker：只在 https 或 localhost 下可用，直接双击打开文件时跳过
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 离线缓存失败不影响计算 */ });
    });
  }
})();
