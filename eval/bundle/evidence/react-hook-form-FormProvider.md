# Reviewed exception evidence: react-hook-form 7.90.0 `FormProvider` (single-export set)

Reproduce: `bun eval/bundle/reference.ts --emit react-hook-form FormProvider` (frozen lock
`locks/wild/react-hook-form.json`; writes `results/emit-react-hook-form-FormProvider.json`).
Entry, the same text depfit builds:

```js
import { FormProvider as __depfit_0 } from "react-hook-form";
globalThis.__depfit = [__depfit_0];
```

| Build | min B | gzip -9 B |
|---|---|---|
| rollup 4.64.7 + terser | 941 | 430 |
| webpack 5.112.0 | 951 | 433 |
| stock Vite 8.3.4 (equals depfit) | 1319 | 592 |
| band (0.9 x min - 100 .. 1.1 x max + 100) | 746.9 .. 1146.1 | 287.0 .. 576.3 |

## Accounting

All three builds keep the same module-level code for this export: the `isWeb` check (`typeof
window`, `document`), the two React contexts with their `displayName`, the bare
`t ? useLayoutEffect : useEffect` expression, and the provider component. Only the Vite output
also keeps two pieces of code from the same module that FormProvider does not use, together 395 B
min:

- 286 B: the EVENTS object, the INPUT_VALIDATION_RULES object, and bare member reads of the latter
  (`r.required, r.min, r.max, r.minLength, r.maxLength, r.pattern, r.validate`).
- 109 B: a default-options object read by bare member expressions
  (`s={mode:n.onSubmit,...};s.mode,s.reValidateMode,s.shouldFocusError`).

rolldown keeps bare member reads, and the objects they read, as possible side effects; rollup with
terser and webpack drop them. Removing exactly those two pieces from the Vite output leaves 924 B
min and 425 B gzip (Node zlib), inside the band and next to the rollup build's 941 / 430 B.
depfit's 1319 / 592 B exceed the band maximum by 172.9 B min and 15.7 B gzip.

## Emitted code

rollup + terser:

```js
import e from"react";var t="undefined"!=typeof window&&void 0!==window.HTMLElement&&"undefined"!=typeof document;const r=e.createContext(null);r.displayName="HookFormControlContext",t?e.useLayoutEffect:e.useEffect;const o=e.createContext(null);o.displayName="HookFormContext";globalThis.__depfit=[({children:t,watch:s,getValues:l,getErrors:a,getFieldState:u,setError:n,clearErrors:i,setValue:c,setValues:d,trigger:g,formState:m,resetField:f,reset:E,resetDefaultValues:F,handleSubmit:V,unregister:b,control:h,register:p,setFocus:v,subscribe:w})=>{const S=e.useMemo(()=>({watch:s,getValues:l,getErrors:a,getFieldState:u,setError:n,clearErrors:i,setValue:c,setValues:d,trigger:g,formState:m,resetField:f,reset:E,resetDefaultValues:F,handleSubmit:V,unregister:b,control:h,register:p,setFocus:v,subscribe:w}),[i,h,m,a,u,l,V,p,E,F,f,n,v,c,d,w,g,b,s]);return e.createElement(o.Provider,{value:S},e.createElement(r.Provider,{value:S.control},t))}];

```

webpack:

```js
import{default as e}from"react";var t="undefined"!=typeof window&&void 0!==window.HTMLElement&&"undefined"!=typeof document;const r=e.createContext(null);r.displayName="HookFormControlContext",t?e.useLayoutEffect:e.useEffect;const o=e.createContext(null);o.displayName="HookFormContext",globalThis.__depfit=[({children:t,watch:s,getValues:l,getErrors:a,getFieldState:u,setError:n,clearErrors:i,setValue:c,setValues:d,trigger:f,formState:g,resetField:m,reset:E,resetDefaultValues:F,handleSubmit:V,unregister:b,control:h,register:p,setFocus:v,subscribe:w})=>{const S=e.useMemo(()=>({watch:s,getValues:l,getErrors:a,getFieldState:u,setError:n,clearErrors:i,setValue:c,setValues:d,trigger:f,formState:g,resetField:m,reset:E,resetDefaultValues:F,handleSubmit:V,unregister:b,control:h,register:p,setFocus:v,subscribe:w}),[i,h,g,a,u,l,V,p,E,F,m,n,v,c,d,w,f,b,s]);return e.createElement(o.Provider,{value:S},e.createElement(r.Provider,{value:S.control},t))}];
```

stock Vite (byte-identical to depfit):

```js
import e from"react";var t=typeof window<`u`&&window.HTMLElement!==void 0&&typeof document<`u`,n={onBlur:`onBlur`,onChange:`onChange`,onSubmit:`onSubmit`,onTouched:`onTouched`,all:`all`},r={max:`max`,min:`min`,maxLength:`maxLength`,minLength:`minLength`,pattern:`pattern`,required:`required`,validate:`validate`};r.required,r.min,r.max,r.minLength,r.maxLength,r.pattern,r.validate;var i=e.createContext(null);i.displayName=`HookFormControlContext`,t?e.useLayoutEffect:e.useEffect;var a=e.createContext(null);a.displayName=`HookFormContext`;var o=({children:t,watch:n,getValues:r,getErrors:o,getFieldState:s,setError:c,clearErrors:l,setValue:u,setValues:d,trigger:f,formState:p,resetField:m,reset:h,resetDefaultValues:g,handleSubmit:_,unregister:v,control:y,register:b,setFocus:x,subscribe:S})=>{let C=e.useMemo(()=>({watch:n,getValues:r,getErrors:o,getFieldState:s,setError:c,clearErrors:l,setValue:u,setValues:d,trigger:f,formState:p,resetField:m,reset:h,resetDefaultValues:g,handleSubmit:_,unregister:v,control:y,register:b,setFocus:x,subscribe:S}),[l,y,p,o,s,r,_,b,h,g,m,c,x,u,d,S,f,v,n]);return e.createElement(a.Provider,{value:C},e.createElement(i.Provider,{value:C.control},t))},s={mode:n.onSubmit,reValidateMode:n.onChange,shouldFocusError:!0};s.mode,s.reValidateMode,s.shouldFocusError,globalThis.__depfit=[o];
```
