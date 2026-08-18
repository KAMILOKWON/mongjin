#!/usr/bin/env python3
"""Generate a standalone iOS app Xcode project."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "Mongjin"
CORE = ROOT / "Sources" / "MongjinCore"

app_files = sorted(p.relative_to(APP) for p in APP.rglob("*.swift"))
core_files = sorted(p.name for p in CORE.glob("*.swift"))

# Mongjin/ 바로 아래의 swift 파일을 담은 하위 폴터들 (Net, Session, Views 등)
subdirs = sorted({rel.parent.name for rel in app_files if rel.parent.name})


def hid(prefix: str, n: int) -> str:
    return f"{prefix}{n:020d}"


lines = []
build_files = []
file_refs = []
source_ids = []

n = 1
for rel in app_files:
    fid = hid("A", n)
    bid = hid("B", n)
    file_refs.append(
        f'\t\t{fid} /* {rel.name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {rel.name}; sourceTree = "<group>"; }};'
    )
    build_files.append(
        f"\t\t{bid} /* {rel.name} in Sources */ = {{isa = PBXBuildFile; fileRef = {fid} /* {rel.name} */; }};"
    )
    source_ids.append((bid, rel))
    n += 1

core_ref_ids = []
for name in core_files:
    fid = hid("C", n)
    bid = hid("D", n)
    file_refs.append(
        f'\t\t{fid} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {name}; sourceTree = "<group>"; }};'
    )
    build_files.append(
        f'\t\t{bid} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {fid} /* {name} */; }};'
    )
    source_ids.append((bid, Path(name)))
    core_ref_ids.append((fid, name))
    n += 1

app_ref = hid("F", 1)
assets_ref = hid("F", 2)
plist_ref = hid("A", 900)
proj = hid("P", 1)
target = hid("P", 2)
sources_phase = hid("P", 3)
resources_phase = hid("P", 4)
frameworks_phase = hid("P", 5)
main_group = hid("G", 1)
products = hid("G", 2)
app_group = hid("G", 3)
core_group = hid("G", 4)
subdir_group = {name: hid("G", 10 + i) for i, name in enumerate(subdirs)}
pkg_ref = hid("E", 1)
pkg_product = hid("E", 2)
pkg_build = hid("E", 3)
cfg_list_proj = hid("K", 1)
cfg_list_tgt = hid("K", 2)
cfg_proj_d = hid("K", 3)
cfg_proj_r = hid("K", 4)
cfg_tgt_d = hid("K", 5)
cfg_tgt_r = hid("K", 6)

# group children by folder
id_by_name = {}
n = 1
for rel in app_files:
    id_by_name[rel.as_posix()] = hid("A", n)
    n += 1

root_children = "\n".join(
    f"\t\t\t\t{i} /* {Path(k).name} */,"
    for k, i in id_by_name.items()
    if not Path(k).parent.name
)
subdir_children = {
    name: "\n".join(
        f"\t\t\t\t{i} /* {Path(k).name} */,"
        for k, i in id_by_name.items()
        if Path(k).parent.name == name
    )
    for name in subdirs
}
subdir_group_entries = "\n".join(
    f"""\t\t{subdir_group[name]} /* {name} */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
{subdir_children[name]}
\t\t\t);
\t\t\tpath = {name};
\t\t\tsourceTree = "<group>";
\t\t}};"""
    for name in subdirs
)
subdir_group_refs = "\n".join(f"\t\t\t\t\t{subdir_group[name]} /* {name} */," for name in subdirs)
core_children = "\n".join(f"\t\t\t\t{fid} /* {name} */," for fid, name in core_ref_ids)
source_entries = "\n".join(f"\t\t\t\t{bid} /* {path.name} in Sources */," for bid, path in source_ids)

pbx = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 56;
	objects = {{

/* Begin PBXBuildFile section */
{chr(10).join(build_files)}
		{pkg_build} /* GoogleMobileAds in Frameworks */ = {{isa = PBXBuildFile; productRef = {pkg_product} /* GoogleMobileAds */; }};
		{hid("B", 900)} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {assets_ref} /* Assets.xcassets */; }};
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
{chr(10).join(file_refs)}
		{plist_ref} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; }};
		{app_ref} /* Mongjin.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Mongjin.app; sourceTree = BUILT_PRODUCTS_DIR; }};
		{assets_ref} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; }};
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		{frameworks_phase} /* Frameworks */ = {{
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{pkg_build} /* GoogleMobileAds in Frameworks */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		{main_group} = {{
			isa = PBXGroup;
			children = (
				{app_group} /* Mongjin */,
				{core_group} /* MongjinCore */,
				{products} /* Products */,
			);
			sourceTree = "<group>";
		}};
		{products} /* Products */ = {{
			isa = PBXGroup;
			children = (
				{app_ref} /* Mongjin.app */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
		{app_group} /* Mongjin */ = {{
			isa = PBXGroup;
			children = (
{root_children}
{subdir_group_refs}
				{assets_ref} /* Assets.xcassets */,
				{plist_ref} /* Info.plist */,
			);
			path = Mongjin;
			sourceTree = "<group>";
		}};
{subdir_group_entries}
		{core_group} /* MongjinCore */ = {{
			isa = PBXGroup;
			children = (
{core_children}
			);
			name = MongjinCore;
			path = Sources/MongjinCore;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		{target} /* Mongjin */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {cfg_list_tgt} /* Build configuration list for PBXNativeTarget "Mongjin" */;
			buildPhases = (
				{sources_phase} /* Sources */,
				{frameworks_phase} /* Frameworks */,
				{resources_phase} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = Mongjin;
			packageProductDependencies = (
				{pkg_product} /* GoogleMobileAds */,
			);
			productName = Mongjin;
			productReference = {app_ref} /* Mongjin.app */;
			productType = "com.apple.product-type.application";
		}};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		{proj} /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
				TargetAttributes = {{
					{target} = {{
						CreatedOnToolsVersion = 16.0;
					}};
				}};
			}};
			buildConfigurationList = {cfg_list_proj} /* Build configuration list for PBXProject "Mongjin" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = ko;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				ko,
				Base,
			);
			mainGroup = {main_group};
			productRefGroup = {products} /* Products */;
			packageReferences = (
				{pkg_ref} /* XCRemoteSwiftPackageReference "swift-package-manager-google-mobile-ads" */,
			);
			projectDirPath = "";
			projectRoot = "";
			targets = (
				{target} /* Mongjin */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		{resources_phase} /* Resources */ = {{
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{hid("B", 900)} /* Assets.xcassets in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		{sources_phase} /* Sources */ = {{
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
{source_entries}
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		{cfg_proj_d} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = dwarf;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				ENABLE_TESTABILITY = YES;
				GCC_DYNAMIC_NO_PIC = NO;
				GCC_OPTIMIZATION_LEVEL = 0;
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
				ONLY_ACTIVE_ARCH = YES;
				SDKROOT = iphoneos;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
				SWIFT_VERSION = 5.0;
			}};
			name = Debug;
		}};
		{cfg_proj_r} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
				ENABLE_NS_ASSERTIONS = NO;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				SDKROOT = iphoneos;
				SWIFT_COMPILATION_MODE = wholemodule;
				SWIFT_VERSION = 5.0;
				VALIDATE_PRODUCT = YES;
			}};
			name = Release;
		}};
		{cfg_tgt_d} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 5;
				DEVELOPMENT_TEAM = M9RZNRX9T4;
				ENABLE_PREVIEWS = YES;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = Mongjin/Info.plist;
				INFOPLIST_KEY_CFBundleDisplayName = "몽진";
				INFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.board-games";
				INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
				INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
				INFOPLIST_KEY_UILaunchScreen_Generation = YES;
				INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;
				INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.studiozzg.mongjin;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SUPPORTS_MACCATALYST = NO;
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_STRICT_CONCURRENCY = targeted;
				TARGETED_DEVICE_FAMILY = 1;
			}};
			name = Debug;
		}};
		{cfg_tgt_r} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 5;
				DEVELOPMENT_TEAM = M9RZNRX9T4;
				ENABLE_PREVIEWS = YES;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = Mongjin/Info.plist;
				INFOPLIST_KEY_CFBundleDisplayName = "몽진";
				INFOPLIST_KEY_LSApplicationCategoryType = "public.app-category.board-games";
				INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;
				INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;
				INFOPLIST_KEY_UILaunchScreen_Generation = YES;
				INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;
				INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.studiozzg.mongjin;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SUPPORTS_MACCATALYST = NO;
				SWIFT_EMIT_LOC_STRINGS = YES;
				SWIFT_STRICT_CONCURRENCY = targeted;
				TARGETED_DEVICE_FAMILY = 1;
			}};
			name = Release;
		}};
/* End XCBuildConfiguration section */

/* Begin XCRemoteSwiftPackageReference section */
		{pkg_ref} /* XCRemoteSwiftPackageReference "swift-package-manager-google-mobile-ads" */ = {{
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/googleads/swift-package-manager-google-mobile-ads.git";
			requirement = {{
				kind = exactVersion;
				version = 13.7.0;
			}};
		}};
/* End XCRemoteSwiftPackageReference section */

/* Begin XCSwiftPackageProductDependency section */
		{pkg_product} /* GoogleMobileAds */ = {{
			isa = XCSwiftPackageProductDependency;
			package = {pkg_ref} /* XCRemoteSwiftPackageReference "swift-package-manager-google-mobile-ads" */;
			productName = GoogleMobileAds;
		}};
/* End XCSwiftPackageProductDependency section */

/* Begin XCConfigurationList section */
		{cfg_list_proj} /* Build configuration list for PBXProject "Mongjin" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{cfg_proj_d} /* Debug */,
				{cfg_proj_r} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{cfg_list_tgt} /* Build configuration list for PBXNativeTarget "Mongjin" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{cfg_tgt_d} /* Debug */,
				{cfg_tgt_r} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
/* End XCConfigurationList section */
	}};
	rootObject = {proj} /* Project object */;
}}
"""

out = ROOT / "Mongjin.xcodeproj" / "project.pbxproj"
out.parent.mkdir(exist_ok=True)
out.write_text(pbx)
print(f"wrote {out}")
print(f"app swift: {len(app_files)} core swift: {len(core_files)}")
for p in app_files:
    print(" ", p)
