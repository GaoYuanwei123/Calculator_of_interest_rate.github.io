/*!
 * loan-core.js —— 等额本息利率反解 + 摊销表生成（纯计算，不碰 DOM）
 *
 * 这是原始 C 代码的移植与加固版本。与原 C 的不同之处：
 *   1. 原 C 的二分查找在“无解”时会死循环（left 与 right 收敛后 mid 不再变化），
 *      这里改成固定迭代次数 + 收敛判断，绝不会卡死。
 *   2. 原 C 只支持月利率 [0.001%, 1000%]，且 0% 无解会卡死；
 *      这里先判断 0 利率，再判断上限，失败时给出明确的中文原因。
 *   3. 原 C 用递归 myPow 求整数次幂，这里直接用 Math.pow（精度更高、无栈深度限制）。
 *
 * 数学背景（和 C 里的公式完全等价）：
 *   设月利率 r，期数 n，贷款本金 A，月供 X，尾款 Q。
 *   所有还款折算到“现在”的价值必须等于本金：
 *       X * (1 - (1+r)^-n) / r  +  Q * (1+r)^-n  =  A
 *   左边的“现值”随 r 单调递减，所以用二分法一定能找到唯一的 r。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LoanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 月利率上限：10 = 1000%/月，与原始 C 代码保持一致 */
  var MAX_MONTHLY_RATE = 10;
  /** 期数上限，防止误输入 1e9 撑爆内存 */
  var MAX_MONTHS = 1200;
  var MAX_ITERATIONS = 400;
  /** 二分停止精度（对月利率而言，1e-15 已远超双精度有效位） */
  var RATE_TOLERANCE = 1e-15;

  /* ---------------- 基础工具 ---------------- */

  function num(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim().replace(/,/g, '');
    if (s === '') return NaN;
    return Number(s);
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* ---------------- 现金流 ---------------- */

  /** 每期还 X 的现值 */
  function presentValueOfPayments(r, payment, months) {
    if (r === 0) return payment * months;
    return (payment * (1 - Math.pow(1 + r, -months))) / r;
  }

  /** 尾款折现 */
  function presentValueOfBalloon(r, balloon, months) {
    if (balloon === 0) return 0;
    if (r === 0) return balloon;
    return balloon * Math.pow(1 + r, -months);
  }

  /** 方程 f(r) = 还款现值 + 尾款现值 - 本金；f(r) 在 r>0 上严格递减 */
  function balanceAt(r, p) {
    return (
      presentValueOfPayments(r, p.payment, p.months) +
      presentValueOfBalloon(r, p.balloon, p.months) -
      p.principal
    );
  }

  /* ---------------- 输入校验 ---------------- */

  function normalizeInput(raw) {
    raw = raw || {};
    return {
      principal: num(raw.principal),
      payment: num(raw.payment),
      months: num(raw.months),
      balloon: raw.balloon === '' || raw.balloon === null || raw.balloon === undefined ? 0 : num(raw.balloon)
    };
  }

  /** field 用来告诉界面应该高亮哪个输入框 */
  function validate(p) {
    if (!isFiniteNumber(p.principal) || p.principal <= 0) {
      return { code: 'principal', field: 'principal', message: '贷款本金必须是大于 0 的数字' };
    }
    if (!isFiniteNumber(p.payment) || p.payment <= 0) {
      return { code: 'payment', field: 'payment', message: '月还款额必须是大于 0 的数字' };
    }
    if (!isFiniteNumber(p.months) || p.months !== Math.floor(p.months)) {
      return { code: 'months', field: 'months', message: '还款月数必须是整数' };
    }
    if (p.months < 1 || p.months > MAX_MONTHS) {
      return { code: 'months', field: 'months', message: '还款月数必须在 1 ~ ' + MAX_MONTHS + ' 之间' };
    }
    if (!isFiniteNumber(p.balloon) || p.balloon < 0) {
      return { code: 'balloon', field: 'balloon', message: '尾款必须是不小于 0 的数字（没有尾款就填 0 或留空）' };
    }
    if (p.balloon >= p.principal) {
      return { code: 'balloon', field: 'balloon', message: '尾款不能大于或等于贷款本金' };
    }
    return null;
  }

  /* ---------------- 核心：二分法反解月利率 ---------------- */

  /**
   * 返回 { rate } 或 { error: {code, message} }
   * code 取值：zero-rate 之外只有 negative / over-limit / not-converged
   */
  function solveMonthlyRate(p) {
    var scale = Math.max(1, p.principal);
    var f0 = balanceAt(0, p);

    // 恰好 0 利率（总还款额 = 本金）
    if (Math.abs(f0) <= 1e-12 * scale) {
      return { rate: 0, iterations: 0 };
    }

    // f(0) < 0：说明总还款少于本金，需要负利率才能成立 —— 不是正常贷款
    if (f0 < 0) {
      return {
        error: {
          code: 'negative',
          field: 'payment',
          message: '月供 × 期数 + 尾款 小于贷款本金，对应的利率是负数（借款方反而倒赚），本工具不支持这种输入'
        }
      };
    }

    // 上限也还太高，说明月供太低，利率超出 1000%/月
    if (balanceAt(MAX_MONTHLY_RATE, p) > 0) {
      return {
        error: {
          code: 'over-limit',
          field: 'payment',
          message: '按这个月供算出来的利率超过 1000%/月（年化超过 12000%），请检查月还款额是否填错'
        }
      };
    }

    var lo = 0;
    var hi = MAX_MONTHLY_RATE;
    var mid = 0;
    var i;
    for (i = 0; i < MAX_ITERATIONS; i++) {
      mid = lo + (hi - lo) / 2;
      // 双精度已无法再把区间切小：此时的 mid 必然等于 lo 或 hi，
      // 若还继续循环就会像原始 C 代码那样永远停不下来。必须在更新前判断。
      if (!(mid > lo && mid < hi)) break;
      var f = balanceAt(mid, p);
      if (f > 0) {
        lo = mid;
      } else {
        hi = mid;
      }
      if (hi - lo <= RATE_TOLERANCE) break;
    }

    if (!(mid >= 0) || !isFinite(mid)) {
      return {
        error: { code: 'not-converged', field: 'payment', message: '利率计算未能收敛，请检查输入' }
      };
    }
    return { rate: (lo + hi) / 2, iterations: i };
  }

  /* ---------------- 摊销表 ---------------- */

  /**
   * 逐期摊还：每期利息 = 期初余额 × r
   *             每期本金 = 月供 - 利息
   *             期末余额 = 期初余额 + 利息 - 月供
   * 最后一期结束后剩余余额应等于尾款 Q（无尾款时为 0）。
   */
  function buildSchedule(p, r) {
    var rows = [];
    var balance = p.principal;
    var totalInterest = 0;
    for (var i = 1; i <= p.months; i++) {
      var interest = balance * r;
      var principalPart = p.payment - interest;
      var end = balance + interest - p.payment;
      totalInterest += interest;
      rows.push({
        period: i,
        payment: p.payment,
        interest: interest,
        principal: principalPart,
        balance: end
      });
      balance = end;
    }
    return { rows: rows, interestSum: totalInterest, residual: balance };
  }

  /* ---------------- 汇总 ---------------- */

  function solve(raw) {
    var p = normalizeInput(raw);
    var invalid = validate(p);
    if (invalid) {
      return { ok: false, error: invalid, input: p };
    }

    var solved = solveMonthlyRate(p);
    if (solved.error) {
      return { ok: false, error: solved.error, input: p };
    }

    var r = solved.rate;
    var table = buildSchedule(p, r);
    var totalPayment = p.payment * p.months + p.balloon;

    return {
      ok: true,
      input: p,
      monthlyRate: r,
      annualRateNominal: r * 12,
      annualRateEffective: r === 0 ? 0 : Math.pow(1 + r, 12) - 1,
      totalPayment: totalPayment,
      totalInterest: totalPayment - p.principal,
      interestBySchedule: table.interestSum,
      balloon: p.balloon,
      residual: table.residual,
      iterations: solved.iterations,
      schedule: table.rows
    };
  }

  /* ---------------- 格式化（纯函数，便于测试） ---------------- */

  /** 金额 -> "1,234.56"；不足 1 分的零头按 0 处理，避免出现 "-0.00" */
  function formatMoney(v) {
    if (!isFinite(v)) return '—';
    var r = Math.round(v * 100) / 100;
    if (Math.abs(r) < 0.005 || r === 0) r = 0;
    var neg = r < 0;
    var s = Math.abs(r).toFixed(2);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }

  /** 比率 -> 百分数字符串，digits 位小数 */
  function formatPercent(v, digits) {
    if (!isFinite(v)) return '—';
    digits = typeof digits === 'number' ? digits : 4;
    return (v * 100).toFixed(digits) + '%';
  }

  /** 导出 CSV（UTF-8 BOM 保证 Excel 不乱码） */
  function toCsv(result) {
    if (!result || !result.ok) return '';
    var lines = [];
    lines.push('期数,月供,利息,本金,期末余额');
    for (var i = 0; i < result.schedule.length; i++) {
      var row = result.schedule[i];
      lines.push(
        [
          row.period,
          row.payment.toFixed(2),
          row.interest.toFixed(2),
          row.principal.toFixed(2),
          row.balance.toFixed(2)
        ].join(',')
      );
    }
    if (result.schedule.length) {
      lines.push(
        [
          '尾款',
          result.balloon.toFixed(2),
          '0.00',
          result.balloon.toFixed(2),
          '0.00'
        ].join(',')
      );
    }
    lines.push('');
    lines.push('年化利率,' + (result.annualRateNominal * 100).toFixed(6) + '%');
    lines.push('月利率,' + (result.monthlyRate * 100).toFixed(6) + '%');
    lines.push('总利息,' + result.totalInterest.toFixed(2));
    lines.push('总还款,' + result.totalPayment.toFixed(2));
    return '\ufeff' + lines.join('\r\n');
  }

  return {
    MAX_MONTHLY_RATE: MAX_MONTHLY_RATE,
    MAX_MONTHS: MAX_MONTHS,
    solve: solve,
    solveMonthlyRate: solveMonthlyRate,
    balanceAt: balanceAt,
    normalizeInput: normalizeInput,
    buildSchedule: buildSchedule,
    formatMoney: formatMoney,
    formatPercent: formatPercent,
    toCsv: toCsv
  };
});
