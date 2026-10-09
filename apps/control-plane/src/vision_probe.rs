use serde_json::{json,Value};
const COLORS: [(&str,[u8;3]);4] = [("red",[255,0,0]),("green",[0,255,0]),("blue",[0,0,255]),("yellow",[255,255,0])];
fn layout(nonce: &str, image: usize) -> [usize;4] {
    let mut order=[0,1,2,3];
    for i in (1..4).rev() { let n=nonce.as_bytes().get(image*4+i).copied().unwrap_or(0);order.swap(i,usize::from(n)%(i+1)); }
    order
}
pub fn expected(nonce: &str) -> Value {
    Value::Array((0..3).map(|i| {let c=layout(nonce,i);json!({"top_left":COLORS[c[0]].0,"top_right":COLORS[c[1]].0,"bottom_left":COLORS[c[2]].0,"bottom_right":COLORS[c[3]].0})}).collect())
}
fn crc(bytes: &[u8]) -> u32 {let mut c=0xffffffff;for b in bytes{c^=u32::from(*b);for _ in 0..8{c=if c&1==1{(c>>1)^0xedb88320}else{c>>1};}}!c}
fn chunk(out: &mut Vec<u8>,name:&[u8;4],data:&[u8]) {out.extend((data.len() as u32).to_be_bytes());let start=out.len();out.extend(name);out.extend(data);out.extend(crc(&out[start..]).to_be_bytes());}
fn png(nonce:&str,index:usize)->Vec<u8> {
    let colors=layout(nonce,index);let mut raw=Vec::new();
    for y in 0..32 {raw.push(0);for x in 0..32{raw.extend(COLORS[colors[(y/16)*2+x/16]].1);}}
    let len=raw.len() as u16;let mut z=vec![0x78,0x01,0x01];z.extend(len.to_le_bytes());z.extend((!len).to_le_bytes());z.extend(&raw);
    let(mut a,mut b)=(1u32,0u32);for v in &raw{a=(a+u32::from(*v))%65521;b=(b+a)%65521;}z.extend(((b<<16)|a).to_be_bytes());
    let mut out=vec![137,80,78,71,13,10,26,10];let mut ihdr=Vec::new();ihdr.extend(32u32.to_be_bytes());ihdr.extend(32u32.to_be_bytes());ihdr.extend([8,2,0,0,0]);
    chunk(&mut out,b"IHDR",&ihdr);chunk(&mut out,b"IDAT",&z);chunk(&mut out,b"IEND",&[]);out
}
fn base64(bytes:&[u8])->String {let table=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";let mut out=String::new();for c in bytes.chunks(3){let n=(u32::from(c[0])<<16)|(u32::from(*c.get(1).unwrap_or(&0))<<8)|u32::from(*c.get(2).unwrap_or(&0));for (i,shift) in [18,12,6,0].into_iter().enumerate(){out.push(if i>c.len(){'='}else{table[((n>>shift)&63) as usize] as char});}}out}
pub fn token_budget(part:&Value)->usize {
    let url=part.pointer("/image_url/url").and_then(Value::as_str).or_else(||part["image_url"].as_str()).unwrap_or("");
    let Some(encoded)=url.strip_prefix("data:image/png;base64,") else{return 4096;};
    let mut bytes=Vec::new();let(mut acc,mut bits)=(0u32,0u8);
    for c in encoded.bytes().take(44) {
        let value=match c{b'A'..=b'Z'=>c-b'A',b'a'..=b'z'=>c-b'a'+26,b'0'..=b'9'=>c-b'0'+52,b'+'=>62,b'/'=>63,_=>return 4096};
        acc=(acc<<6)|u32::from(value);bits+=6;if bits>=8{bits-=8;bytes.push((acc>>bits) as u8);}
    }
    if bytes.len()<24||!bytes.starts_with(&[137,80,78,71,13,10,26,10]){return 4096;}
    let w=u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let h=u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as usize;
    if w==0||h==0||w>8192||h>8192{return 1_000_000;}
    w.div_ceil(28).saturating_mul(h.div_ceil(28)).max(1024)
}
pub fn prompt(model:&str,nonce:&str)->String {
    let mut content=vec![json!({"type":"text","text":"For each of the three images in order, identify the colors in the four quadrants. Return only a JSON array of three objects with keys top_left, top_right, bottom_left, bottom_right. Use lowercase color names. Do not infer colors from the text; inspect the images."})];
    for i in 0..3 {content.push(json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",base64(&png(nonce,i)))}}));}
    format!("__MUNDUSX_OPENAI_TOOL_TURN_V1__{}",json!({"model":model,"messages":[{"role":"user","content":content}],"stream":false,"max_tokens":256,"temperature":0}))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn challenges_carry_pixels_and_answers_are_not_in_text() {
        let text=prompt("vision-model","abcdef0123456789abcdef0123456789");
        let body:Value=serde_json::from_str(text.strip_prefix("__MUNDUSX_OPENAI_TOOL_TURN_V1__").unwrap()).unwrap();
        assert_eq!(body["messages"][0]["content"].as_array().unwrap().len(),4);
        assert!(body["messages"][0]["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,iVBOR"));
        assert_ne!(expected("abcdef0123456789abcdef0123456789"),expected("0123456789abcdef0123456789abcdef"));
        assert_eq!(base64(b"a"),"YQ==");assert_eq!(base64(b"ab"),"YWI=");assert_eq!(base64(b"abc"),"YWJj");
        assert_eq!(token_budget(&body["messages"][0]["content"][1]),1024);
        let request:crate::contracts::ChatCompletionRequest=serde_json::from_value(body).unwrap();
        assert!(crate::chat_gateway::is_native_tool_turn(&request));
        assert!(crate::chat_gateway::validate_image_inputs(&request).is_ok());
        let mut remote=request;remote.messages[0].content[1]["image_url"]["url"]=json!("https://internal.example/image.png");
        assert!(crate::chat_gateway::validate_image_inputs(&remote).is_err());
    }
}
