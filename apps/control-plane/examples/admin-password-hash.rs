use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use std::io::{self, Read};
fn main() {
    let mut password=String::new();
    io::stdin().take(4097).read_to_string(&mut password).expect("read password from stdin");
    let password=password.trim_end_matches(['\r','\n']);
    if !(12..=1024).contains(&password.len()) { eprintln!("Password must be 12–1024 UTF-8 bytes."); std::process::exit(1); }
    let salt=SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes()).expect("salt");
    println!("{}",Argon2::default().hash_password(password.as_bytes(),&salt).expect("hash password"));
}
