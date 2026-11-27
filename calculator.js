const PRESETS = {
  NDVI: '(B8-B4)/(B8+B4)',
  EVI: '2.5*(B8-B4)/(B8+6*B4-7.5*B2+1)',
  ARVI: '(B8-(2*B4-B2))/(B8+(2*B4-B2))',
  AFRI: '(B8-0.66*B11)/(B8+0.66*B11)',
  SAVI: '1.5*(B8-B4)/(B8+B4+0.5)',
  NDRE: '(B8A-B5)/(B8A+B5)',
  NDMI: '(B8A-B11)/(B8A+B11)',
  GNDVI: '(B8-B3)/(B8+B3)',
  MSAVI2: '0.5*(2*B8+1-sqrt((2*B8+1)^2-8*(B8-B4)))',
  OSAVI: '(B8-B4)/(B8+B4+0.16)',
};
const ATMOSPHERIC_PRESETS = ['NDVI','EVI','ARVI','AFRI'];
const BANDS = ['B2','B3','B4','B5','B6','B7','B8','B8A','B11','B12'];
const GROWTH = { B2:-.004,B3:-.006,B4:-.030,B5:-.012,B6:.035,B7:.055,B8:.070,B8A:.068,B11:-.047,B12:-.040 };
const LATE = { B4:.012,B5:.009,B11:.015,B12:.012 };

let meta, bandData, atmosphereLut, vegetation, formulaFn, baseValues, scenarioValues, baseStats, scenarioStats, scale;
let currentName = 'NDVI';
let displayMode = 'index';
const sortedBandCache = {};
let scenarioState = { aod:0, water:0, growth:0, late:false, optics:{}, baselineOptics:{} };
let updateTimer;
const $ = selector => document.querySelector(selector);

function setMessage(message, error=false) {
  $('#message').textContent = message;
  $('#message').classList.toggle('error', error);
}

function tokenize(source) {
  const tokens = [];
  const pattern = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z][A-Za-z0-9]*|[()+\-*/^,]/y;
  let position = 0;
  while (position < source.length) {
    if (/\s/.test(source[position])) { position++; continue; }
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) throw new Error(`无法识别第 ${position+1} 个字符：${source[position]}`);
    tokens.push(match[0]);
    position = pattern.lastIndex;
  }
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source);
  if (!tokens.length) throw new Error('请输入公式');
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const requireToken = expected => { if (take() !== expected) throw new Error(`缺少 ${expected}`); };

  function primary() {
    const token = take();
    if (token === '+' || token === '-') {
      const fn = expression(4);
      return token === '+' ? fn : (i, scenario) => -fn(i, scenario);
    }
    if (token === '(') {
      const fn = expression(0);
      requireToken(')');
      return fn;
    }
    if (token && /^(?:\d|\.)/.test(token)) {
      const number = Number(token);
      return () => number;
    }
    if (token && /^[A-Za-z]/.test(token)) {
      const name = token.toUpperCase();
      if (BANDS.includes(name)) return (i, scenario) => readBand(name, i, scenario);
      if (peek() !== '(') throw new Error(`未知波段或函数：${token}`);
      take();
      const args = [];
      if (peek() !== ')') {
        do {
          args.push(expression(0));
          if (peek() !== ',') break;
          take();
        } while (true);
      }
      requireToken(')');
      const key = token.toLowerCase();
      const arity = { sqrt:1, abs:1, log:1, exp:1, pow:2, min:2, max:2 }[key];
      if (!arity || args.length < arity || (key !== 'min' && key !== 'max' && args.length !== arity)) throw new Error(`函数 ${token} 的参数数量不正确`);
      return (i, scenario) => {
        const values = args.map(fn => fn(i, scenario));
        if (key === 'sqrt') return Math.sqrt(values[0]);
        if (key === 'abs') return Math.abs(values[0]);
        if (key === 'log') return Math.log(values[0]);
        if (key === 'exp') return Math.exp(values[0]);
        if (key === 'pow') return Math.pow(values[0], values[1]);
        return key === 'min' ? Math.min(...values) : Math.max(...values);
      };
    }
    throw new Error(token ? `公式在 ${token} 附近不完整` : '公式未结束');
  }

  function expression(minimum) {
    let left = primary();
    const precedence = { '+':1, '-':1, '*':2, '/':2, '^':4 };
    while (precedence[peek()] >= minimum) {
      const op = take();
      const right = expression(precedence[op] + (op === '^' ? 0 : 1));
      const previous = left;
      if (op === '+') left = (i,s) => previous(i,s) + right(i,s);
      else if (op === '-') left = (i,s) => previous(i,s) - right(i,s);
      else if (op === '*') left = (i,s) => previous(i,s) * right(i,s);
      else if (op === '/') left = (i,s) => { const divisor = right(i,s); return Math.abs(divisor) < 1e-10 ? NaN : previous(i,s) / divisor; };
      else left = (i,s) => Math.pow(previous(i,s), right(i,s));
    }
    return left;
  }
  const result = expression(0);
  if (position !== tokens.length) throw new Error(`公式在 ${peek()} 附近无法解析`);
  return result;
}

function readBand(name, pixel, scenario) {
  const original = bandData[name][pixel];
  if (!scenario || !Number.isFinite(original)) return original;
  const grow = vegetation[pixel] ? scenarioState.growth : 0;
  const late = vegetation[pixel] && scenarioState.late ? (LATE[name] || 0) : 0;
  const adjusted = original + GROWTH[name]*grow + late;
  if (scenarioState.aod === 0 && scenarioState.water === 0) return adjusted;
  const surface = Math.min(1, Math.max(0, adjusted));
  const { path, transmission, spherical } = scenarioState.optics[name];
  const baseline = scenarioState.baselineOptics[name];
  const simulated = path + transmission * surface / (1 - spherical * surface);
  const clear = baseline.path + baseline.transmission * surface / (1 - baseline.spherical * surface);
  return adjusted + simulated - clear;
}

function axisWeights(nodes, value) {
  const last = nodes.length - 1;
  if (value <= nodes[0]) return [0, 0, 0];
  if (value >= nodes[last]) return [last, last, 0];
  let upper = 1;
  while (nodes[upper] < value) upper++;
  const lower = upper - 1;
  return [lower, upper, (value - nodes[lower]) / (nodes[upper] - nodes[lower])];
}

function interpolateOptics(profile, aod, water) {
  const [a0,a1,at] = axisWeights(atmosphereLut.aod_nodes,aod);
  const [w0,w1,wt] = axisWeights(atmosphereLut.water_cm_nodes,water);
  const grid = atmosphereLut.coefficients[profile];
  const optics = {};
  BANDS.forEach((name,band) => {
    const sample = (a,w,coefficient) => grid[a][w][band][coefficient];
    const blend = coefficient => {
      const low = sample(a0,w0,coefficient)*(1-wt) + sample(a0,w1,coefficient)*wt;
      const high = sample(a1,w0,coefficient)*(1-wt) + sample(a1,w1,coefficient)*wt;
      return low*(1-at) + high*at;
    };
    optics[name] = { path:blend(0), transmission:blend(1), spherical:blend(2) };
  });
  return optics;
}

function readScenarioState() {
  const aod = +$('#aerosol').value, water = +$('#water').value;
  $('#aerosolOut').textContent = aod.toFixed(2);
  $('#waterOut').textContent = `${water.toFixed(1)} cm`;
  $('#vigorOut').textContent = $('#vigor').value;
  const phase = $('#phase').value;
  const shift = { baseline:0, early:-.70, peak:.45, late:-.80 }[phase];
  const growth = Math.max(-1, Math.min(1, ((+$('#vigor').value - 50)/50)*.65 + shift));
  const smoke = $('#aerosolType').value === 'smoke';
  const optics = interpolateOptics(smoke ? 'smoke' : 'haze', aod, .5 + water);
  const baselineOptics = interpolateOptics('haze', 0, .5);
  scenarioState = { aod, water, growth, late:phase==='late', optics, baselineOptics };
  $('#atmosNote').textContent = aod >= 2
    ? '高 AOD 时地表信号可能被遮蔽，植被指数难以解释。'
    : aod === 0 && water === 0
      ? '无额外大气干扰：情景波段与输入波段相同。'
      : '使用 6S 模拟相对于无额外干扰情景的反射率变化。';
}

function calculatePixels(fn, scenario) {
  const values = new Float32Array(meta.width * meta.height);
  const valid = [];
  for (let i=0; i<values.length; i++) {
    if (!Number.isFinite(bandData.B2[i])) { values[i] = NaN; continue; }
    const value = fn(i, scenario);
    values[i] = Number.isFinite(value) ? value : NaN;
    if (Number.isFinite(value)) valid.push(value);
  }
  if (!valid.length) throw new Error('此公式没有产生有效像元，请检查分母和函数定义');
  valid.sort((a,b) => a-b);
  const at = p => valid[Math.floor((valid.length-1)*p)];
  return { values, stats:{ count:valid.length, p02:at(.02), median:at(.5), p98:at(.98) } };
}

function color(value) {
  const from = value < 0 ? [47,105,152] : [221,210,158];
  const to = value < 0 ? [221,210,158] : [28,112,63];
  const t = Math.max(0, Math.min(1, value < 0 ? value+1 : value));
  return [0,1,2].map(c => Math.round(from[c]*(1-t)+to[c]*t));
}

function histogramCounts(values, binCount) {
  const bins = new Uint32Array(binCount);
  let below = 0, above = 0, valid = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    valid++;
    if (value < -1) below++;
    else if (value > 1) above++;
    else bins[Math.min(binCount-1, Math.floor((value+1)*binCount/2))]++;
  }
  return { bins, below, above, valid };
}

function drawHistogram() {
  const canvas = $('#histogram'), context = canvas.getContext('2d');
  const original = histogramCounts(baseValues, 32), scenario = histogramCounts(scenarioValues, 32);
  const left = 44, top = 12, width = canvas.width-left-12, height = canvas.height-top-36;
  const percent = (count, total) => total ? count*100/total : 0;
  const maxPercent = Math.max(1, ...Array.from(original.bins, count => percent(count, original.valid)), ...Array.from(scenario.bins, count => percent(count, scenario.valid)));
  context.clearRect(0,0,canvas.width,canvas.height);
  context.font = '12px Arial';
  context.fillStyle = '#607166';
  context.strokeStyle = '#d5ded7';
  context.lineWidth = 1;
  for (let tick=0; tick<=2; tick++) {
    const y = top+height*(1-tick/2);
    context.beginPath(); context.moveTo(left,y+.5); context.lineTo(left+width,y+.5); context.stroke();
    context.fillText(`${(maxPercent*tick/2).toFixed(1)}%`,3,y+4);
  }
  const step = width/original.bins.length;
  const plot = (series, stroke, dashed) => {
    context.beginPath();
    context.strokeStyle = stroke;
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.setLineDash(dashed ? [6,4] : []);
    for (let i=0; i<series.bins.length; i++) {
      const x = left+(i+.5)*step;
      const y = top+height-height*percent(series.bins[i],series.valid)/maxPercent;
      if (i===0) context.moveTo(x,y); else context.lineTo(x,y);
    }
    context.stroke();
    context.setLineDash([]);
  };
  plot(original,'#46769b',false);
  plot(scenario,'#dd8842',true);
  context.strokeStyle = '#6c766d';
  context.beginPath(); context.moveTo(left+width/2,top); context.lineTo(left+width/2,top+height); context.stroke();
  context.fillStyle = '#506255';
  for (const [label,fraction] of [['−1',0],['0',.5],['1',1]]) {
    const x = left+width*fraction;
    context.fillText(label,x-(label==='0'?3:7),top+height+17);
  }
  $('#histInfo').textContent = `折线连接各等宽区间的像元比例；情景结果使用虚线。范围外：输入影像 < −1 ${percent(original.below,original.valid).toFixed(2)}%、> 1 ${percent(original.above,original.valid).toFixed(2)}%；情景结果 < −1 ${percent(scenario.below,scenario.valid).toFixed(2)}%、> 1 ${percent(scenario.above,scenario.valid).toFixed(2)}%。`;
  canvas.setAttribute('aria-label', `${currentName} 输入影像与情景结果的数值分布折线图，横轴负一至一，纵轴各自有效像元百分比`);
}

function drawMap() {
  if (displayMode === 'rgb') { drawRgb(); return; }
  if (!baseValues) return;
  const scenario = document.querySelector('input[name="view"]:checked').value === 'scenario';
  const values = scenario ? scenarioValues : baseValues;
  const canvas = $('#map');
  const context = canvas.getContext('2d');
  const image = context.createImageData(meta.width, meta.height);
  for (let i=0; i<values.length; i++) {
    const offset = i*4;
    if (!Number.isFinite(values[i])) { image.data[offset+3] = 0; continue; }
    const rgb = color(values[i]);
    image.data[offset] = rgb[0]; image.data[offset+1] = rgb[1]; image.data[offset+2] = rgb[2]; image.data[offset+3] = 255;
  }
  context.putImageData(image,0,0);
  $('#scaleMin').textContent = format(scale.low);
  $('#scaleMax').textContent = format(scale.high);
  const zeroVisible = true;
  $('#zeroMarker').hidden = !zeroVisible;
  if (zeroVisible) {
    const position = 100 * (0-scale.low)/(scale.high-scale.low);
    $('#zeroMarker').style.left = `${position}%`;
    $('#indexRamp').style.background = `linear-gradient(90deg,#2f6998 0%,#ddd29e ${position}%,#1c703f 100%)`;
  } else $('#indexRamp').style.background = '';
  $('#result-title').textContent = `${currentName} 计算结果`;
  canvas.setAttribute('aria-label', `${currentName} 指数地图`);
  $('#resultSubtitle').textContent = scenario ? '6S 模拟观测' : '输入地表反射率';
  $('#modeBadge').textContent = scenario ? '6S 模拟' : '输入影像计算';
  $('#modeBadge').classList.toggle('sim', scenario);
  $('#validCount').textContent = `有效像元：${(scenario ? scenarioStats.count : baseStats.count).toLocaleString()} / ${(meta.width*meta.height).toLocaleString()}。`;
  drawHistogram();
}

function bandPercentile(name, percent) {
  if (!sortedBandCache[name]) {
    const sorted = [];
    for (const value of bandData[name]) if (Number.isFinite(value)) sorted.push(value);
    sorted.sort((a,b) => a-b);
    sortedBandCache[name] = sorted;
  }
  const sorted = sortedBandCache[name];
  return sorted[Math.floor((sorted.length-1) * percent / 100)];
}

function drawRgb() {
  if (!bandData) return;
  const simulated = document.querySelector('input[name="rgbSource"]:checked').value === 'scenario';
  const names = [$('#redBand').value, $('#greenBand').value, $('#blueBand').value];
  const lowPercent = +$('#stretchLow').value, highPercent = +$('#stretchHigh').value;
  const bounds = names.map(name => [bandPercentile(name, lowPercent), bandPercentile(name, highPercent)]);
  const canvas = $('#map'), context = canvas.getContext('2d');
  const image = context.createImageData(meta.width, meta.height);
  for (let i=0; i<meta.width*meta.height; i++) {
    const offset = i*4;
    if (!Number.isFinite(bandData.B2[i])) { image.data[offset+3] = 0; continue; }
    for (let channel=0; channel<3; channel++) {
      const [low, high] = bounds[channel];
      const value = readBand(names[channel], i, simulated);
      image.data[offset+channel] = Math.round(255 * Math.max(0, Math.min(1, (value-low)/(high-low || 1e-9))));
    }
    image.data[offset+3] = 255;
  }
  context.putImageData(image,0,0);
  $('#result-title').textContent = `${simulated ? '情景影像' : '输入影像'} · 波段组合`;
  $('#resultSubtitle').textContent = `R ${names[0]} · G ${names[1]} · B ${names[2]}`;
  $('#modeBadge').textContent = simulated ? '6S 模拟' : '输入波段';
  $('#modeBadge').classList.toggle('sim', simulated);
  canvas.setAttribute('aria-label', `${simulated ? '情景' : '输入'}影像波段组合：红色 ${names[0]}，绿色 ${names[1]}，蓝色 ${names[2]}`);
  $('#stretchLowOut').textContent = `${lowPercent}%`;
  $('#stretchHighOut').textContent = `${highPercent}%`;
  $('#rgbInfo').textContent = `${simulated ? '情景影像' : '输入影像'}；两种视图均按输入波段的 ${lowPercent}%–${highPercent}% 分位线性拉伸。输入反射率范围：R ${format(bounds[0][0])}–${format(bounds[0][1])}，G ${format(bounds[1][0])}–${format(bounds[1][1])}，B ${format(bounds[2][0])}–${format(bounds[2][1])}。`;
}

function showDisplayMode(mode) {
  displayMode = mode;
  $('#showIndex').classList.toggle('active', mode === 'index');
  $('#showRgb').classList.toggle('active', mode === 'rgb');
  $('#rgbControls').hidden = mode !== 'rgb';
  $('#rgbInfo').hidden = mode !== 'rgb';
  $('#indexBelow').hidden = mode !== 'index';
  drawMap();
}

function format(value) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000 || (Math.abs(value) < .001 && value !== 0)) return value.toExponential(2);
  return value.toFixed(3);
}

function showStats() {
  $('#baseMedian').textContent = format(baseStats.median);
  $('#scenarioMedian').textContent = format(scenarioStats.median);
  const diff = scenarioStats.median-baseStats.median;
  $('#delta').textContent = `${diff > .0005 ? '+' : ''}${format(diff)}`;
}

function renderAtmosComparison() {
  if (!bandData) return;
  const rows = ATMOSPHERIC_PRESETS.map(name => {
    const fn = parse(PRESETS[name]);
    const original = [], scenario = [];
    for (let i=0; i<meta.width*meta.height; i+=16) {
      if (!vegetation[i]) continue;
      const a = fn(i,false), b = fn(i,true);
      if (Number.isFinite(a) && Number.isFinite(b)) { original.push(a); scenario.push(b); }
    }
    original.sort((a,b)=>a-b); scenario.sort((a,b)=>a-b);
    const median = values => values.length ? values[Math.floor((values.length-1)/2)] : NaN;
    return { name, base:median(original), current:median(scenario), count:original.length };
  });
  $('#comparisonTable').innerHTML = `<table><thead><tr><th>指数</th><th>原始</th><th>情景</th><th>差值</th></tr></thead><tbody>${rows.map(row => `<tr><th>${row.name}</th><td>${format(row.base)}</td><td>${format(row.current)}</td><td>${format(row.current-row.base)}</td></tr>`).join('')}</tbody></table><small>原始 NDVI &gt; 0.35 的像元中，每 16 个像元抽取 1 个；有效样本约 ${rows[0].count.toLocaleString()} 个。</small>`;
}

function recalculateScenario() {
  if (!formulaFn) return;
  readScenarioState();
  try {
    const result = calculatePixels(formulaFn, true);
    scenarioValues = result.values;
    scenarioStats = result.stats;
    showStats();
    renderAtmosComparison();
    drawMap();
  } catch (error) { setMessage(error.message, true); }
}

function calculateFormula() {
  if (!bandData) return;
  try {
    const next = parse($('#formula').value.trim());
    const result = calculatePixels(next, false);
    formulaFn = next;
    baseValues = result.values;
    baseStats = result.stats;
    currentName = Object.keys(PRESETS).find(name => PRESETS[name] === $('#formula').value.replace(/\s+/g,'')) || '自定义公式';
    document.querySelectorAll('.presets button').forEach(button => button.classList.toggle('active', button.textContent === currentName));
    scale = { low:-1, high:1 };
    recalculateScenario();
    setMessage(`计算完成：${baseStats.count.toLocaleString()} 个有效像元`);
  } catch (error) { setMessage(error.message, true); }
}

function initControls() {
  for (const [name, expression] of Object.entries(PRESETS)) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = name;
    button.addEventListener('click', () => { $('#formula').value = expression; calculateFormula(); });
    $('#presets').append(button);
  }
  for (const band of BANDS) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = band; button.title = `插入 ${band}`;
    button.addEventListener('click', () => {
      const input = $('#formula'), start = input.selectionStart, end = input.selectionEnd;
      input.setRangeText(band,start,end,'end'); input.focus();
    });
    $('#bandButtons').append(button);
  }
  $('#calculate').addEventListener('click', calculateFormula);
  $('#formula').addEventListener('keydown', event => { if (event.key === 'Enter') calculateFormula(); });
  for (const id of ['aerosolType','aerosol','water','vigor','phase']) {
    $(`#${id}`).addEventListener(id === 'phase' || id === 'aerosolType' ? 'change' : 'input', () => {
      readScenarioState();
      document.querySelector('input[name="view"][value="scenario"]').checked = true;
      document.querySelector('input[name="rgbSource"][value="scenario"]').checked = true;
      clearTimeout(updateTimer);
      updateTimer = setTimeout(recalculateScenario, 100);
    });
  }
  document.querySelectorAll('input[name="view"]').forEach(radio => radio.addEventListener('change', drawMap));
  document.querySelectorAll('input[name="rgbSource"]').forEach(radio => radio.addEventListener('change', drawRgb));
  $('#reset').addEventListener('click', () => {
    $('#aerosolType').value='haze'; $('#aerosol').value=0; $('#water').value=0; $('#vigor').value=50; $('#phase').value='baseline';
    document.querySelector('input[name="view"][value="observed"]').checked=true;
    document.querySelector('input[name="rgbSource"][value="observed"]').checked=true;
    recalculateScenario();
  });
  $('#smokeExample').addEventListener('click', () => {
    $('#aerosolType').value='smoke'; $('#aerosol').value=2.5; $('#water').value=2.5;
    document.querySelector('input[name="view"][value="scenario"]').checked=true;
    document.querySelector('input[name="rgbSource"][value="scenario"]').checked=true;
    recalculateScenario();
  });
  for (const id of ['redBand','greenBand','blueBand']) {
    const select = $(`#${id}`);
    for (const band of BANDS) select.add(new Option(band, band));
    select.addEventListener('change', () => {
      document.querySelectorAll('.rgb-presets button').forEach(button => button.classList.remove('active'));
      drawRgb();
    });
  }
  $('#redBand').value='B4'; $('#greenBand').value='B3'; $('#blueBand').value='B2';
  document.querySelectorAll('.rgb-presets button').forEach(button => button.addEventListener('click', () => {
    const [red,green,blue] = button.dataset.rgb.split(',');
    $('#redBand').value=red; $('#greenBand').value=green; $('#blueBand').value=blue;
    document.querySelectorAll('.rgb-presets button').forEach(item => item.classList.toggle('active', item === button));
    drawRgb();
  }));
  for (const id of ['stretchLow','stretchHigh']) $(`#${id}`).addEventListener('input', drawRgb);
  $('#showIndex').addEventListener('click', () => showDisplayMode('index'));
  $('#showRgb').addEventListener('click', () => showDisplayMode('rgb'));
}

async function load() {
  initControls();
  try {
    const [metaResponse, binaryResponse, lutResponse] = await Promise.all([fetch('assets/bands.json'),fetch('assets/bands-f32.bin'),fetch('assets/atmosphere-6s.json')]);
    if (!metaResponse.ok || !binaryResponse.ok || !lutResponse.ok) throw new Error('影像或大气模型读取失败');
    meta = await metaResponse.json();
    atmosphereLut = await lutResponse.json();
    if (atmosphereLut.bands.join(',') !== BANDS.join(',')) throw new Error('大气模型波段与影像不一致');
    const buffer = await binaryResponse.arrayBuffer();
    const size = meta.width*meta.height;
    if (buffer.byteLength !== size*meta.band_order.length*4) throw new Error('波段文件大小与元数据不一致');
    bandData = {};
    meta.band_order.forEach((name,i) => { bandData[name] = new Float32Array(buffer,i*size*4,size); });
    vegetation = new Uint8Array(size);
    for (let i=0; i<size; i++) {
      const n=bandData.B8[i], r=bandData.B4[i];
      vegetation[i] = Number.isFinite(n) && Number.isFinite(r) && n+r>1e-8 && (n-r)/(n+r)>.35 ? 1 : 0;
    }
    calculateFormula();
  } catch (error) { setMessage(error.message, true); }
}
load();
