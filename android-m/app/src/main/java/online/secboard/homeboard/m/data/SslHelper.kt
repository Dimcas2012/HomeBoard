package online.secboard.homeboard.m.data

import android.content.Context
import online.secboard.homeboard.m.R
import java.io.BufferedInputStream
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Android 6 не містить ISRG Root X1 (Let's Encrypt) у системному сховищі.
 * Додаємо корінь вручну + системні сертифікати.
 */
object SslHelper {
    fun trustManager(context: Context): X509TrustManager {
        val cf = CertificateFactory.getInstance("X.509")
        val isrg = context.resources.openRawResource(R.raw.isrgrootx1).use { raw ->
            cf.generateCertificate(BufferedInputStream(raw)) as X509Certificate
        }

        val defaultTmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        defaultTmf.init(null as KeyStore?)

        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("isrgrootx1", isrg)
            // copy system trusted anchors when possible
            val defaultTm = defaultTmf.trustManagers
                .filterIsInstance<X509TrustManager>()
                .first()
            defaultTm.acceptedIssuers.forEachIndexed { index, cert ->
                setCertificateEntry("system_$index", cert)
            }
        }

        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(keyStore)
        return tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    fun sslContext(trustManager: X509TrustManager): SSLContext {
        return SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), null)
        }
    }
}
