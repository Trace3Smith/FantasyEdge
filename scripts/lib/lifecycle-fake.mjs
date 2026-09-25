// Adapter for existing in-memory handler fixtures. This is not Lua verification:
// check:credential-lifecycle runs the actual production script in disposable Redis.
export function installLifecycleFake(redis) {
  redis.eval = async (_script, keys, args) => {
    const [op,expected,user,json,ttl]=args, [rev,creds,prefs,members,watch,ack,dna,gen,manual,pending,ready]=keys;
    const current=String(await redis.get(rev)??0);
    if(op==='read')return [current,await redis.get(creds)??'',await redis.get(gen)??'',await redis.get(ready)??''];
    if(op!=='disconnect' && current!==expected)return null;
    const p=JSON.parse(json);
    if(op==='permission'&&p.on&&!await redis.get(creds))return null;
    const next=String(Number(current)+1);
    await redis.set(rev,next);
    if(['connect','disconnect','clear'].includes(op)){await redis.del(prefs);await redis.srem(members,user);}
    if(['connect','disconnect'].includes(op)){await redis.del(watch);}
    if(op==='connect'){await redis.set(creds,p.envelope,{ex:Number(ttl)});await redis.set(gen,p.connectionId);await redis.set(ready,'1');await redis.del(ack);await redis.srem(dna,user);await redis.del(manual);await redis.del(pending);}
    if(op==='disconnect'){await redis.del(gen);await redis.del(ready);await redis.del(manual);await redis.del(pending);await redis.del(creds);await redis.del(ack);await redis.srem(dna,user);}
    if(op==='dna-clear'){await redis.del(ack);await redis.srem(dna,user);}
    if(op==='watch'||op==='manual')await redis.set(op==='watch'?watch:manual,p);
    if(op==='permission'){
      const all=await redis.get(prefs)||{};
      for(const alias of p.aliases)delete all[alias];
      if(p.on)all[p.key]=p.value;
      await redis.set(prefs,all);
      await redis[Object.keys(all).length?'sadd':'srem'](members,user);
    }
    const consent=op==='connect'?p.consent:op==='dna'?p:null;
    if(consent){await redis.set(ack,{...consent,connectionId:op==='connect'?p.connectionId:await redis.get(gen)});await redis[consent.include?'sadd':'srem'](dna,user);}
    return next;
  };
}
