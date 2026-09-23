// testgen's transcoder: test sources decoded and encoded with the very charset javac reads them in.
// Run by libs/encoding.ts, compiled once per JDK; Java 8 compatible. The logic is all on the
// TypeScript side — this only does what Node cannot: MS950, GBK, Shift_JIS and the rest, exactly
// as the JDK defines them.
//
//   Transcode decode <charset> <request>  each line "<in>\t<out>": <in> strictly decoded, written to <out> as UTF-8
//   Transcode encode <charset> <request>  each line "<in>\t<out>": <in> (UTF-8) strictly encoded, written to <out>
//   Transcode probe  <charset> <request>  line 1 is a UTF-8 file: prints the code points it holds that cannot be encoded
//   Transcode info                        prints the default charset and the Java specification version
//
// One line of output per request line: "OK", or "ERR <reason>". Output is UTF-8.
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

public class Transcode {
  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    if (args[0].equals("info")) {
      out.println(Charset.defaultCharset().name());
      out.println(System.getProperty("java.specification.version"));
      return;
    }
    Charset cs = Charset.forName(args[1]);
    List<String> lines = Files.readAllLines(Paths.get(args[2]), StandardCharsets.UTF_8);
    if (args[0].equals("probe")) {
      String text = strictUtf8(Files.readAllBytes(Paths.get(lines.get(0))));
      CharsetEncoder enc = cs.newEncoder();
      StringBuilder missing = new StringBuilder();
      for (int i = 0; i < text.length(); ) {
        int cp = text.codePointAt(i);
        String ch = new String(Character.toChars(cp));
        if (!enc.canEncode(ch)) missing.append(Integer.toHexString(cp)).append(' ');
        i += Character.charCount(cp);
      }
      out.println(missing.toString().trim());
      return;
    }
    for (String line : lines) {
      if (line.isEmpty()) continue;
      String[] p = line.split("\t");
      try {
        byte[] in = Files.readAllBytes(Paths.get(p[0]));
        if (args[0].equals("decode")) {
          CharsetDecoder dec = cs.newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT);
          Files.write(Paths.get(p[1]), dec.decode(ByteBuffer.wrap(in)).toString().getBytes(StandardCharsets.UTF_8));
        } else {
          CharsetEncoder enc = cs.newEncoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT);
          ByteBuffer bytes = enc.encode(CharBuffer.wrap(strictUtf8(in)));
          byte[] b = new byte[bytes.remaining()];
          bytes.get(b);
          Files.write(Paths.get(p[1]), b);
        }
        out.println("OK");
      } catch (Exception e) {
        out.println("ERR " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
      }
    }
  }

  private static String strictUtf8(byte[] in) throws Exception {
    return StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(in))
        .toString();
  }
}
