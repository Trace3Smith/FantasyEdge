// Adapter for existing in-memory handler fixtures. This is not Lua verification:
// check:credential-lifecycle runs the actual production script in disposable Redis.
export function installLifecycleFake(redis) {
  redis.eval = async (_script, keys, args) => {
    const [op,expected,user,json,ttl]=args, [rev,creds,prefs,members,watch,ack,dna]=keys;
    const current=String(await redis.get(rev)??0);
    if(op==='read')return [current,await redis.get(creds)??''];
    if(op!=='disconnect' && current!==expected)return null;
    const p=JSON.parse(json);
    if(op==='permission'&&p.on&&!await redis.get(creds))return null;
    const next=String(Number(current)+1);
    await redis.set(rev,next);
    if(['connect','disconnect','clear'].includes(op)){await redis.del(prefs);await redis.srem(members,user);}
    if(['connect','disconnect'].includes(op)){
      const w=await redis.get(watch);
      if(w)await redis.set(watch,Object.fromEntries(Object.entries(w).map(([k,v])=>[k,{...v,previousLeague:v.lg||v.previousLeague||null,lg:'',leagueName:''}])));
    }
    if(op==='connect')await redis.set(creds,p.envelope,{ex:Number(ttl)});
    if(op==='disconnect'){await redis.del(creds);await redis.del(ack);await redis.srem(dna,user);}
    if(op==='dna-clear'){await redis.del(ack);await redis.srem(dna,user);}
    if(op==='permission'){
      const all=await redis.get(prefs)||{};
      for(const alias of p.aliases)delete all[alias];
      if(p.on)all[p.key]=p.value;
      await redis.set(prefs,all);
      await redis[Object.keys(all).length?'sadd':'srem'](members,user);
    }
    const consent=op==='connect'?p.consent:op==='dna'?p:null;
    if(consent){await redis.set(ack,consent);await redis[consent.include?'sadd':'srem'](dna,user);}
    return next;
  };
}
