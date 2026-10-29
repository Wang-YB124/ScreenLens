import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PKG = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
PKG_VERSION = PKG['version']
OUT = os.path.join(ROOT, f"ScreenLens-Code-{PKG_VERSION}.vsix")

MANIFEST = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{PKG['name']}" Version="{PKG['version']}" Publisher="{PKG['publisher']}" />
    <DisplayName>{PKG['displayName']}</DisplayName>
    <Description xml:space="preserve">{PKG['description']}</Description>
    <Tags>ai,code explanation,code fix,deepseek,screenlens</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{PKG['engines']['vscode']}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
'''

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr('extension.vsixmanifest', MANIFEST)
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    for name in ['package.json', 'extension.js', 'core.js', 'live.js', 'README.md', 'LICENSE.txt']:
        z.write(os.path.join(ROOT, name), f'extension/{name}')

print(OUT, os.path.getsize(OUT))
