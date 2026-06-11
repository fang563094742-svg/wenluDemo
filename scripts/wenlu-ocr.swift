#!/usr/bin/env swift
// wenlu-ocr.swift - macOS 原生 OCR 工具 (基于 VisionKit)
// 用途：对图像文件进行文字识别，作为 grow_limb 创建的工具链一部分
// 依赖：macOS 12+ (Monterey)，无需第三方包
//
// 用法：wenlu-ocr <image_path>
// 输出：识别的文本（stdout），错误信息（stderr）

import Foundation
import Vision
import AppKit

enum OCRError: Error, CustomStringConvertible {
    case noImage(String)
    case visionFailed(String)
    case noText

    var description: String {
        switch self {
        case .noImage(let msg): return "无法加载图像: \(msg)"
        case .visionFailed(let msg): return "Vision 识别失败: \(msg)"
        case .noText: return "未识别到任何文字"
        }
    }
}

func loadImage(from path: String) -> NSImage? {
    let url = URL(fileURLWithPath: path)
    guard let data = try? Data(contentsOf: url) else { return nil }
    return NSImage(data: data)
}

func performOCR(on image: NSImage, languages: [String] = ["en-US", "zh-Hans"]) throws -> String {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw OCRError.noImage("无法转换为 CGImage")
    }

    let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true

    try requestHandler.perform([request])

    guard let observations = request.results, !observations.isEmpty else {
        throw OCRError.noText
    }

    let texts = observations.compactMap { observation -> String? in
        observation.topCandidates(1).first?.string
    }

    if texts.isEmpty {
        throw OCRError.noText
    }

    return texts.joined(separator: "\n")
}

// ---- Main ----

func main() {
    let args = CommandLine.arguments

    if args.count < 2 {
        fputs("用法: wenlu-ocr <image_path>\n", stderr)
        fputs("  对图像文件进行 OCR 文字识别（macOS VisionKit）\n", stderr)
        fputs("  支持 PNG/JPG/TIFF/BMP 等常见格式\n", stderr)
        fputs("  输出识别的文字到 stdout\n", stderr)
        exit(1)
    }

    let path = args[1]

    if path == "--version" {
        print("wenlu-ocr 1.0.0 (macOS VisionKit)")
        exit(0)
    }

    guard let image = loadImage(from: path) else {
        fputs("错误: 无法加载图像 '\(path)'\n", stderr)
        exit(1)
    }

    do {
        let text = try performOCR(on: image)
        print(text)
    } catch {
        fputs("OCR 失败: \(error)\n", stderr)
        exit(1)
    }
}

main()
