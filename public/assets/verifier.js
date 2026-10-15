// Exact arithmetic and a small grammar; no eval, model call, or network request.
export function checkExpression(source) {
  const supplied=[3,3,8,8];
  const normalized=String(source).replaceAll('×','*').replaceAll('÷','/').replaceAll('−','-').trim();
  const used=[];
  let tokens=[],position=0;
  const gcd=(a,b)=>{a=a<0n?-a:a;b=b<0n?-b:b;while(b){[a,b]=[b,a%b];}return a||1n;};
  const fraction=(n,d=1n)=>{if(d===0n)throw new Error('Division by zero is undefined.');if(d<0n){n=-n;d=-d;}if(n>10n**32n||n<-(10n**32n)||d>10n**32n)throw new Error('That expression is too large for this example.');const g=gcd(n,d);return {n:n/g,d:d/g};};
  function primary(){const t=tokens[position++];if(t==='('){const v=expression();if(tokens[position++]!==')')throw new Error('Close each parenthesis.');return v;}if(t==='+'||t==='-'){const v=primary();return fraction(t==='-'?-v.n:v.n,v.d);}if(!t||!/^\d+$/.test(t))throw new Error('Use whole numbers, arithmetic operators, and parentheses.');if(t.length>6)throw new Error('Use small whole numbers for this example.');used.push(Number(t));return fraction(BigInt(t));}
  function term(){let v=primary();while(tokens[position]==='*'||tokens[position]==='/'){const op=tokens[position++],w=primary();v=op==='*'?fraction(v.n*w.n,v.d*w.d):fraction(v.n*w.d,v.d*w.n);}return v;}
  function expression(){let v=term();while(tokens[position]==='+'||tokens[position]==='-'){const op=tokens[position++],w=term();v=fraction(v.n*w.d+(op==='+'?1n:-1n)*w.n*v.d,v.d*w.d);}return v;}
  try {
    if(!normalized)throw new Error('Enter an expression to check.');
    if(normalized.length>120)throw new Error('Keep the expression to 120 characters or fewer.');
    if(/[^\d\s()+*/-]/.test(normalized))throw new Error('Use whole numbers, +, −, *, / and parentheses.');
    tokens=normalized.match(/\d+|[()+*/-]/g)||[];
    if(tokens.length>80)throw new Error('That expression is too long for this example.');
    const result=expression();
    if(position!==tokens.length)throw new Error('An operator or parenthesis is missing.');
    const numeric=result.n===24n*result.d;
    const inputs=used.length===4&&used.toSorted((a,b)=>a-b).every((n,i)=>n===supplied[i]);
    const value=result.d===1n?String(result.n):`${result.n}/${result.d}`;
    const message=numeric&&inputs?'Both checks pass. The expression equals 24 and uses each supplied number exactly once.':numeric?'The number is right, but the input rule is broken. A result-only check would accept an invalid solution.':inputs?`The inputs are used correctly, but the expression equals ${value}, not 24.`:`The expression equals ${value}. It also does not use exactly the supplied numbers.`;
    return {valid:true,numeric,inputs,value,message};
  }catch(error){return {valid:false,numeric:false,inputs:false,value:null,message:error.message};}
}
