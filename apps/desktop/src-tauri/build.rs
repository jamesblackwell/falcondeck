fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/macos_dictation.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("falcondeck_macos_dictation");
        cc::Build::new()
            .file("src/macos_sounds.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("falcondeck_macos_sounds");
        cc::Build::new()
            .file("src/macos_computer_use.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("falcondeck_macos_computer_use");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Carbon");
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
        link_macos_clang_rt();
        println!("cargo:rerun-if-changed=src/macos_dictation.m");
        println!("cargo:rerun-if-changed=src/macos_sounds.m");
        println!("cargo:rerun-if-changed=src/macos_computer_use.m");
        println!("cargo:rerun-if-changed=src/dictation_events.h");
    }

    tauri_build::build()
}

/// `@available` in the ObjC sources emits `___isPlatformVersionAtLeast`.
/// rustc release links with `-nodefaultlibs`, so clang_rt has to be added by us.
#[cfg(target_os = "macos")]
fn link_macos_clang_rt() {
    let output = std::process::Command::new("clang")
        .arg("--print-file-name=libclang_rt.osx.a")
        .output()
        .expect("clang --print-file-name=libclang_rt.osx.a");
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = std::path::Path::new(&path);
    if !output.status.success() || !path.is_file() {
        panic!(
            "could not find libclang_rt.osx.a (needed to link @available checks): {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    println!(
        "cargo:rustc-link-search={}",
        path.parent().expect("libclang_rt.osx.a parent").display()
    );
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
