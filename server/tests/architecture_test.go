package tests

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestArchitectureGuardrails enforces clean domain-driven architecture and slice isolation
// modeled after enterprise standards (like socialradio/src/architecture.spec.ts).
func TestArchitectureGuardrails(t *testing.T) {
	rootPath := ".."

	t.Run("Rule 1: Domain Isolation (domain/ cannot depend on features or infrastructure)", func(t *testing.T) {
		domainPath := filepath.Join(rootPath, "domain")
		fset := token.NewFileSet()
		pkgs, err := parser.ParseDir(fset, domainPath, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("failed to parse domain package: %v", err)
		}

		for _, pkg := range pkgs {
			for filename, file := range pkg.Files {
				for _, imp := range file.Imports {
					importPath := strings.Trim(imp.Path.Value, `"`)
					if strings.Contains(importPath, "server/features") || strings.Contains(importPath, "server/infrastructure") {
						t.Errorf("VIOLATION: domain file %s imports non-domain package %s", filepath.Base(filename), importPath)
					}
				}
			}
		}
	})

	t.Run("Rule 2: Zero Cross-Slice Concrete Imports (features/<A> cannot import features/<B>)", func(t *testing.T) {
		featuresPath := filepath.Join(rootPath, "features")
		slices := []string{"config", "games", "session"}

		for _, slice := range slices {
			sliceDir := filepath.Join(featuresPath, slice)
			err := filepath.WalkDir(sliceDir, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
					return err
				}

				fset := token.NewFileSet()
				node, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
				if err != nil {
					return err
				}

				for _, imp := range node.Imports {
					importPath := strings.Trim(imp.Path.Value, `"`)
					for _, otherSlice := range slices {
						if otherSlice == slice {
							continue
						}
						forbidden := "server/features/" + otherSlice
						if strings.Contains(importPath, forbidden) {
							t.Errorf("VIOLATION: feature slice '%s' (%s) imports peer slice '%s' (%s)",
								slice, filepath.Base(path), otherSlice, importPath)
						}
					}
				}
				return nil
			})
			if err != nil {
				t.Fatalf("failed to inspect slice %s: %v", slice, err)
			}
		}
	})

	t.Run("Rule 3: Infrastructure Independence (infrastructure cannot import features)", func(t *testing.T) {
		infraPath := filepath.Join(rootPath, "infrastructure")
		err := filepath.WalkDir(infraPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
				return err
			}

			fset := token.NewFileSet()
			node, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}

			for _, imp := range node.Imports {
				importPath := strings.Trim(imp.Path.Value, `"`)
				if strings.Contains(importPath, "server/features") {
					t.Errorf("VIOLATION: infrastructure file %s imports feature slice %s", filepath.Base(path), importPath)
				}
			}
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("failed to inspect infrastructure: %v", err)
		}
	})

	t.Run("Rule 4: Domain Anti-Dumping Guardrail (all types in domain/ must be cross-slice)", func(t *testing.T) {
		domainPath := filepath.Join(rootPath, "domain")
		fset := token.NewFileSet()
		pkgs, err := parser.ParseDir(fset, domainPath, nil, 0)
		if err != nil {
			t.Fatalf("failed to parse domain package: %v", err)
		}

		var domainExports []string
		for _, pkg := range pkgs {
			for _, file := range pkg.Files {
				for _, decl := range file.Decls {
					genDecl, ok := decl.(*ast.GenDecl)
					if !ok || genDecl.Tok != token.TYPE {
						continue
					}
					for _, spec := range genDecl.Specs {
						typeSpec, ok := spec.(*ast.TypeSpec)
						if ok && typeSpec.Name.IsExported() {
							domainExports = append(domainExports, typeSpec.Name.Name)
						}
					}
				}
			}
		}

		if len(domainExports) == 0 {
			t.Fatalf("no domain types found")
		}

		featuresPath := filepath.Join(rootPath, "features")
		entries, err := os.ReadDir(featuresPath)
		if err != nil {
			t.Fatalf("failed to read features dir: %v", err)
		}

		var featureSlices []string
		for _, e := range entries {
			if e.IsDir() {
				featureSlices = append(featureSlices, e.Name())
			}
		}

		for _, symbol := range domainExports {
			consumingSlices := make(map[string]bool)

			for _, slice := range featureSlices {
				sliceDir := filepath.Join(featuresPath, slice)
				_ = filepath.WalkDir(sliceDir, func(path string, d fs.DirEntry, err error) error {
					if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
						return nil
					}
					content, readErr := os.ReadFile(path)
					if readErr == nil && strings.Contains(string(content), symbol) {
						consumingSlices[slice] = true
					}
					return nil
				})
			}

			if len(consumingSlices) < 2 {
				var sliceList []string
				for s := range consumingSlices {
					sliceList = append(sliceList, s)
				}
				sort.Strings(sliceList)
				t.Errorf("🚨 Anti-Dumping Violation: Symbol '%s' in domain/ is only consumed by %d slice(s) ([%s]). Move private types into the owning feature slice.",
					symbol, len(consumingSlices), strings.Join(sliceList, ", "))
			}
		}
	})

	t.Run("Rule 5: Zero Bidirectional Slice Coupling (Acyclic Dependency Graph)", func(t *testing.T) {
		featuresPath := filepath.Join(rootPath, "features")
		entries, err := os.ReadDir(featuresPath)
		if err != nil {
			t.Fatalf("failed to read features dir: %v", err)
		}

		var featureSlices []string
		for _, e := range entries {
			if e.IsDir() {
				featureSlices = append(featureSlices, e.Name())
			}
		}

		deps := make(map[string]map[string]bool)
		for _, slice := range featureSlices {
			deps[slice] = make(map[string]bool)
			sliceDir := filepath.Join(featuresPath, slice)
			_ = filepath.WalkDir(sliceDir, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
					return nil
				}
				fset := token.NewFileSet()
				node, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
				if parseErr != nil {
					return nil
				}
				for _, imp := range node.Imports {
					importPath := strings.Trim(imp.Path.Value, `"`)
					for _, other := range featureSlices {
						if other != slice && strings.Contains(importPath, "features/"+other) {
							deps[slice][other] = true
						}
					}
				}
				return nil
			})
		}

		for sliceA, targets := range deps {
			for sliceB := range targets {
				if deps[sliceB][sliceA] {
					t.Errorf("🚨 Architecture Violation: Bidirectional dependency cycle detected between slices [%s] and [%s].", sliceA, sliceB)
				}
			}
		}
	})

	t.Run("Rule 6: Single Model / Entity Ownership", func(t *testing.T) {
		featuresPath := filepath.Join(rootPath, "features")
		entries, err := os.ReadDir(featuresPath)
		if err != nil {
			t.Fatalf("failed to read features dir: %v", err)
		}

		typeLocations := make(map[string]map[string]bool)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			slice := e.Name()
			sliceDir := filepath.Join(featuresPath, slice)
			_ = filepath.WalkDir(sliceDir, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
					return nil
				}
				fset := token.NewFileSet()
				node, parseErr := parser.ParseFile(fset, path, nil, 0)
				if parseErr != nil {
					return nil
				}
				for _, decl := range node.Decls {
					genDecl, ok := decl.(*ast.GenDecl)
					if !ok || genDecl.Tok != token.TYPE {
						continue
					}
					for _, spec := range genDecl.Specs {
						typeSpec, ok := spec.(*ast.TypeSpec)
						if ok && typeSpec.Name.IsExported() {
							typeName := typeSpec.Name.Name
							// Allow standard DTO / Service / Controller suffixes if scoped to slice
							if typeLocations[typeName] == nil {
								typeLocations[typeName] = make(map[string]bool)
							}
							typeLocations[typeName][slice] = true
						}
					}
				}
				return nil
			})
		}

		for typeName, slices := range typeLocations {
			if len(slices) > 1 {
				var sliceList []string
				for s := range slices {
					sliceList = append(sliceList, s)
				}
				sort.Strings(sliceList)
				t.Errorf("🚨 Architecture Violation: Duplicate type '%s' defined across slices [%s]. Every entity/model must be owned exclusively by a single domain slice or promoted to domain/types.",
					typeName, strings.Join(sliceList, ", "))
			}
		}
	})

	t.Run("Rule 7: Route Domain Ownership (No Cross-Domain Controller Routes)", func(t *testing.T) {
		featuresPath := filepath.Join(rootPath, "features")
		entries, err := os.ReadDir(featuresPath)
		if err != nil {
			t.Fatalf("failed to read features dir: %v", err)
		}

		var featureSlices []string
		for _, e := range entries {
			if e.IsDir() {
				featureSlices = append(featureSlices, e.Name())
			}
		}

		for _, slice := range featureSlices {
			sliceDir := filepath.Join(featuresPath, slice)
			_ = filepath.WalkDir(sliceDir, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
					return nil
				}
				content, readErr := os.ReadFile(path)
				if readErr != nil {
					return nil
				}

				// Find HandleFunc registrations
				lines := strings.Split(string(content), "\n")
				for _, line := range lines {
					if strings.Contains(line, "HandleFunc(") || strings.Contains(line, "@Router") {
						for _, otherSlice := range featureSlices {
							if otherSlice == slice {
								continue
							}
							// Route pattern check: e.g. /api/games in config controller
							pattern := "/api/" + otherSlice
							if strings.Contains(line, pattern) {
								t.Errorf("🚨 Architecture Violation: Controller in slice '%s' (%s) declares route '%s' belonging to slice '%s'.",
									slice, filepath.Base(path), pattern, otherSlice)
							}
						}
					}
				}
				return nil
			})
		}
	})
}
