// Test-only Lua 5.1 protection for Redis-supplied tables. Empty proxies catch writes
// even to existing indices; aliases refer to the same protected proxy. The C table
// helpers/rawset need explicit guards because they can bypass __newindex in 5.1.
// Lua 5.1 ignores table __len, so only #KEYS/#ARGV expressions are adapted to a
// length helper. All current application/operator input-length uses have this form.
// This approximates hosted input immutability, not every Upstash engine behavior.
export function readonlyLuaInputs(script) {
  const body = script.replace(/#\s*(KEYS|ARGV)\b/g, '__inputLength($1)');
  return `
local originals = {}
local function protect(source)
 local proxy = {}
 originals[proxy] = source
 return setmetatable(proxy, {
  __index = source,
  __newindex = function() error('READONLY_REDIS_INPUT') end,
  __metatable = false
 })
end
local protectedKeys, protectedArgs = protect(KEYS), protect(ARGV)
local realIpairs, realPairs, realUnpack, realRawset, realRawget = ipairs, pairs, unpack, rawset, rawget
local realTable = table
local function __inputLength(t) return #(originals[t] or t) end
local function inputIpairs(t)
 if not originals[t] then return realIpairs(t) end
 return function(_, i) local n=i+1; local value=originals[t][n]; if value~=nil then return n,value end end, t, 0
end
local function inputPairs(t)
 if not originals[t] then return realPairs(t) end
 return function(_, key) return next(originals[t],key) end, t, nil
end
local function inputUnpack(t,i,j) return realUnpack(originals[t] or t,i or 1,j or __inputLength(t)) end
local function inputRawset(t,k,v)
 if originals[t] then error('READONLY_REDIS_INPUT') end
 return realRawset(t,k,v)
end
local inputTable = {}
for name,fn in realPairs(realTable) do inputTable[name]=fn end
for _,name in realIpairs({'remove','insert','sort','setn'}) do
 local fn=realTable[name]
 inputTable[name]=function(t,...)
  if originals[t] then error('READONLY_REDIS_INPUT') end
  return fn(t,...)
 end
end
inputTable.concat=function(t,...) return realTable.concat(originals[t] or t,...) end
return (function(KEYS, ARGV, ipairs, pairs, unpack, rawset, rawget, table)
${body}
end)(protectedKeys,protectedArgs,inputIpairs,inputPairs,inputUnpack,inputRawset,
 function(t,k) return realRawget(originals[t] or t,k) end,inputTable)
`;
}
