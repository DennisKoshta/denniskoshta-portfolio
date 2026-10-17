// Temporary theme experiments. Loaded before CSS to restore a local choice without a flash.
(() => {
  const key = 'portfolio-theme-preview-v1';
  const presets = [
    {id:'paper', name:'Paper', bg:'#f6f5f1', accent:'#526779'},
    {id:'porcelain', name:'Porcelain', bg:'#f5f7fa', accent:'#456b94'},
    {id:'sand', name:'Sand', bg:'#f2eee6', accent:'#796348'},
    {id:'mist', name:'Mist', bg:'#edf2f2', accent:'#426b70'},
    {id:'mono', name:'Monochrome', bg:'#f3f3f3', accent:'#555555'},
    {id:'slate', name:'Blue slate', bg:'#242e40', accent:'#9acdf7'}
  ];
  const hex = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  const rgb = color => color.slice(1).match(/../g).map(v => parseInt(v,16));
  const mix = (a,b,t) => '#' + rgb(a).map((v,i) => Math.round(v*(1-t)+rgb(b)[i]*t).toString(16).padStart(2,'0')).join('');
  const luminance = color => rgb(color).map(v => {v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  function colors(theme) {
    const bg=theme.bg, dark=luminance(bg)<.179;
    const ink=dark?'#ffffff':'#000000';
    const surface=mix(bg,dark&&luminance(bg)>.12?'#000000':'#ffffff',dark?.065:.6);
    const field=mix(bg,dark?'#000000':'#ffffff',dark?.12:.35);
    const hover=mix(surface,dark?'#000000':'#ffffff',.04);
    const backgrounds=[bg,surface,field,hover];
    function readable(color,minimum=4.5) {
      for(let i=0;i<=100;i++){
        const candidate=mix(color,ink,i/100);
        if(backgrounds.every(b=>contrast(candidate,b)>=minimum))return candidate;
      }
      return ink;
    }
    const link=readable(theme.accent), muted=readable(mix(ink,bg,.37));
    const selection=link;
    return {
      'bg':bg,'text':readable(mix(ink,bg,.13)),'heading':readable(dark?'#f5f7fa':'#15202a'),'accent':link,'link':link,'muted':muted,
      'rule':mix(bg,ink,.22),'surface':surface,'field':field,'field-border':readable(mix(bg,ink,.4),3.1),
      'selection':selection,'selection-text':contrast('#ffffff',selection)>contrast('#15202a',selection)?'#ffffff':'#15202a',
      'shadow':`0 8px 24px ${dark?'#09142229':'#18232d0b'}`,
      'shadow-hover':`0 12px 26px ${dark?'#09142240':'#18232d16'}`,
      'research':link,'products':link,'studio':link,'top-wash':bg,
      'nav-hover':surface,'nav-active':hover,'nav-border':mix(bg,theme.accent,.2),
      'dot':mix(bg,theme.accent,.3),'portrait-border':mix(bg,ink,.25),'portrait-offset':mix(bg,theme.accent,.12),
      'tile-border':mix(bg,ink,.16),'tile-highlight':dark?'#ffffff09':'#ffffff99','tile-hover':hover,
      'writing-rule':mix(bg,theme.accent,.45),'side-bg':surface,
      'scheme':dark?'dark':'light'
    };
  }
  let current={...presets[0]};
  function apply(theme,persist=true) {
    if(!theme || !hex(theme.bg) || !hex(theme.accent))return;
    const preset=presets.find(p=>p.bg.toLowerCase()===theme.bg.toLowerCase()&&p.accent.toLowerCase()===theme.accent.toLowerCase());
    current={id:preset?.id||'custom',name:preset?.name||'Custom',bg:theme.bg.toLowerCase(),accent:theme.accent.toLowerCase()};
    const tokens=colors(current),root=document.documentElement;
    for(const [name,value] of Object.entries(tokens))if(name!=='scheme')root.style.setProperty('--'+name,value);
    root.style.colorScheme=tokens.scheme;
    root.dataset.theme=current.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',current.bg);
    if(persist)try{localStorage.setItem(key,JSON.stringify(current));}catch{}
  }
  try {const stored=JSON.parse(localStorage.getItem(key));if(stored&&hex(stored.bg)&&hex(stored.accent))current=stored;}catch{}
  apply(current,false);
  window.portfolioTheme={presets,colors,get current(){return {...current};},apply,reset(){apply(presets[0],false);try{localStorage.removeItem(key);}catch{}}};
})();
