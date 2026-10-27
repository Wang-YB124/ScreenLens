const v = 'eiπ + 1 = 0, where e is the base of the natural logarithm.';
const equations = v.match(/[A-Za-z0-9α-ωΑ-Ω)\]²³¹⁰-₟]\s*(?:=|<|>|≈|≠|≤|≥|\+|\*|\/|\^)\s*[A-Za-z0-9α-ωΑ-Ω(\[]/g);
console.log('eq', equations);
console.log('sym', v.match(/[∫∑∏√πθλμΔ∞≈≠≤≥±×÷∈∉⊂⊆∪∩→⇒⇔∴∵∂∇]/g));
const sh = 'git status\nnpm install\nchmod +x run.sh';
console.log('shell lines', sh.split(/\r?\n/).filter((line) => /^\s*(?:\$|>)?\s*(?:git|npm|pnpm|yarn|pip|python|node|docker|kubectl|sudo|chmod|mkdir|cd|curl|wget|powershell|cmd)\b/.test(line)));
console.log('cli regex', /\b(npm|pip|git|docker|kubectl|sudo|chmod|mkdir|curl|powershell|cmd|yarn|pnpm)\s+/i.test(sh));
