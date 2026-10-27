const DOMAINS = ['auto', 'general', 'code', 'math', 'science'];

const DOMAIN_LABELS = {
  auto: '自动',
  general: '通用',
  code: '代码',
  math: '数学',
  science: '科普',
};

function normalizeDomain(value, fallback = 'auto') {
  const domain = String(value || '').toLowerCase();
  return DOMAINS.includes(domain) ? domain : fallback;
}

function detectDomain(input) {
  const value = String(input || '').trim();
  if (!value) return 'general';

  let codeScore = 0;
  let mathScore = 0;
  let scienceScore = 0;

  if (/```|~~~/.test(value)) codeScore += 3;

  const keywordPattern = /\b(function|class|const|let|var|def|import|from|export|return|async|await|public|private|protected|static|void|struct|enum|impl|trait|interface|namespace|package|using|include|console\.log|print\(|printf\(|fmt\.Print|System\.out|elif|else:|try:|catch\b|throws?\b|new\s+[A-Z]|fn\s+\w+|pub\s+\w+|match\s+\w+|mut\b|echo\s+|then\s*$|fi\s*$|done\s*$)\b/gm;
  const keywordHits = (value.match(keywordPattern) || []).length;
  codeScore += Math.min(4, keywordHits * 0.9);
  if (/\b(def|function|class)\s+[A-Za-z_$][\w$]*\s*\(/.test(value)) codeScore += 2;
  if (/\bdef\s+[A-Za-z_]\w*\s*\(/.test(value) && /\breturn\b/.test(value)) codeScore += 1.5;
  if (/^\s*#include\s*[<"]/m.test(value)) codeScore += 2;
  if (/<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?>/m.test(value)) codeScore += 2;
  if (/(=>|::|->|:=)/.test(value)) codeScore += 1.2;
  if (/;\s*$/m.test(value)) codeScore += 1;
  if (/^\s{2,}\S/m.test(value)) codeScore += 0.8;
  if (/^\s*(?:\/\/|\/\*|\*)/m.test(value) && keywordHits > 0) codeScore += 0.6;
  if (/\b(npm|pip|git|docker|kubectl|sudo|chmod|mkdir|curl|powershell|cmd|yarn|pnpm)\s+/i.test(value)) codeScore += 1.3;
  const shellLines = value.split(/\r?\n/).filter((line) => /^\s*(?:\$|>)?\s*(?:git|npm|pnpm|yarn|pip|python|node|docker|kubectl|sudo|chmod|mkdir|cd|curl|wget|powershell|cmd)\b/.test(line)).length;
  if (shellLines >= 2) codeScore += 2.4;
  if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|FROM|WHERE)\b/.test(value)) codeScore += 1.6;
  if (/\b[a-zA-Z-]+\s*:\s*[^;\n]+;/m.test(value) && /[{}]/.test(value)) codeScore += 1.1;
  if (/^\s*[\{\[]\s*["']/m.test(value)) codeScore += 1;
  if (/\b(Type|interface|string|number|boolean|any|Promise|Map|List|Dict|Optional|Nullable)\b/.test(value) && /[:<>]/.test(value)) codeScore += 0.7;
  const braceCount = (value.match(/[{}]/g) || []).length;
  const parenCount = (value.match(/[()]/g) || []).length;
  if (braceCount + parenCount > 6) codeScore += 0.6;

  if (/(\\[a-zA-Z]+|\$\$?[^$]+\$\$?|\\\(|\\\[)/.test(value)) mathScore += 3;
  const mathSymbols = (value.match(/[∫∑∏√πθλμΔ∞≈≠≤≥±×÷∈∉⊂⊆∪∩→⇒⇔∴∵∂∇]/g) || []).length;
  mathScore += Math.min(3, mathSymbols * 0.8);
  const equationPattern = /(?=([A-Za-z0-9α-ωΑ-Ω)\]²³¹⁰-₟]\s*(?:=|<|>|≈|≠|≤|≥|\+|\*|\/|\^)\s*[A-Za-z0-9α-ωΑ-Ω(\[]))/g;
  const equations = [...value.matchAll(equationPattern)];
  mathScore += Math.min(2.4, equations.length * 0.6);
  if (/[²³¹⁰⁴-⁹₀-₉]/.test(value)) mathScore += 0.9;
  const mathWords = value.match(/\b(sin|cos|tan|log|ln|lim|sum|integral|matrix|vector|derivative|probability|theorem|lemma|equation|proof|solve|sigma|delta|circle|sphere|radius|diameter|circumference|triangle|hypotenuse|angle|geometry|area|volume)\b|定理|公式|方程|函数|概率|积分|导数|矩阵|向量|求证|求解|不等式|级数|排列|组合|圆|球|半径|直径|面积|体积|三角|几何/gi) || [];
  mathScore += Math.min(2, mathWords.length * 0.8);

  const scienceWords = value.match(/\b(quantum|relativity|entropy|thermodynamics|evolution|natural selection|photosynthesis|protein|enzyme|DNA|RNA|cell membrane|atom|molecule|electron|photon|neuron|gravity|black hole|dark matter|machine learning|neural network|algorithm|semiconductor|vaccine|immune|hormone|biodiversity|tectonic|climate|universe|particle|newton|acceleration|velocity|momentum|friction|wavelength|frequency|voltage|circuit|physics)\b|量子|相对论|熵|热力学|进化|自然选择|光合作用|蛋白质|酶|基因|细胞|原子|分子|电子|光子|神经元|引力|黑洞|暗物质|机器学习|神经网络|算法|半导体|疫苗|免疫|激素|生物多样性|板块|气候|宇宙|恒星|粒子|牛顿|加速度|动量|摩擦|波长|频率|电压|电路|物理/gi) || [];
  scienceScore += Math.min(3.6, scienceWords.length * 1.2);

  if (codeScore >= 2.5 && codeScore >= mathScore) return 'code';
  if (scienceScore >= 2.4 && scienceScore >= mathScore && codeScore < 2) return 'science';
  if (mathScore >= 2.0 && mathScore > codeScore) return 'math';
  if (scienceScore >= 1.2 && codeScore < 2 && mathScore < 2) return 'science';
  return 'general';
}

module.exports = {
  DOMAINS,
  DOMAIN_LABELS,
  normalizeDomain,
  detectDomain,
};
