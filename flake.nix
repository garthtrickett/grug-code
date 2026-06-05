{
  description = "Local-first language acquisition dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forEachSystem = f: nixpkgs.lib.genAttrs supportedSystems (system: f (import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      }));
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            bashInteractive
            pkg-config
          ];

          buildInputs = with pkgs; [
            nodejs_22
            bun
            esbuild
            chromium
            unzip
            curl
            python3
          ];

          shellHook = ''
            echo "🚀 Grug Code Development Environment Loaded"
            echo "Bun: $(bun --version)"
            echo "Node: $(node --version)"
            
            # Playwright Configurations
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
          '';
        };
      });
    };
}
